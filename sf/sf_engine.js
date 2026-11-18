/*
 * sf_engine.js — ブラウザで動く Stockfish（Stockfish.js 18 lite single）を使うための小さな部品
 * 対局準備アプリ（chess-prep）の「その場の検討」から、サーバーに頼らない形に切り出したもの。
 *
 * 必要なファイル（同じフォルダに置く。オフラインで使うならアプリに同梱する）
 *   stockfish-18-lite-single.js / stockfish-18-lite-single.wasm  （npm の stockfish@18 の bin/ にある。約7MB）
 * 表記（Nf3 など）に直したいときは chess.js（ESM版でも、window.Chess でも可）を渡す。無ければ UCI（g1f3）のまま。
 *
 * 評価値はすべて「白から見た値」（+なら白が良い）。cp はセンチポーン（100 = 1ポーン）。
 *
 * 使い方
 *   const eng = new SFEngine({ script: "sf/stockfish-18-lite-single.js", Chess });   // Chess は任意
 *   await eng.init();
 *   // ① 調べ続けて、途中経過を受け取る（検討パネル向け）
 *   eng.onUpdate = (r) => draw(r);      // r = { fen, depth, searching, lines: [...] }
 *   eng.analyze(fen, { multipv: 3, movetime: 20000 });
 *   eng.stop();
 *   // ② 一度だけ調べて結果を待つ（答え合わせ向け）
 *   const r = await eng.evaluate(fen, { multipv: 3, movetime: 3000 });
 *   // ③ 特定の手だけを調べる（「自分の手はどのくらい悪いか」）
 *   const mine = await eng.evaluate(fen, { searchmoves: ["e2e4"], movetime: 3000 });
 *
 * lines の1行 = { k, depth, cp, mate, pv: ["g1f3", ...], san: ["Nf3", ...], text: "+0.35", line: "12.Nf3 Nc6 13.Bb5" }
 */
(function (root) {
  "use strict";

  function evalText(l) {
    if (!l) return "";
    if (l.mate != null) return (l.mate > 0 ? "+M" : "-M") + Math.abs(l.mate);
    return (l.cp >= 0 ? "+" : "") + (l.cp / 100).toFixed(2);
  }

  // 白から見た値を、手番側から見た値に直す（「指した側にとって何点失ったか」の計算などに）
  function forSide(l, fen) {
    const s = fen.split(" ")[1] === "w" ? 1 : -1;
    return l.mate != null ? { mate: s * l.mate, cp: null } : { cp: s * l.cp, mate: null };
  }

  // 比べやすい数値に（詰みは ±100000 に近い値）
  function score(l) {
    if (!l) return 0;
    if (l.mate != null) return (l.mate > 0 ? 1 : -1) * (100000 - Math.abs(l.mate) * 100);
    return l.cp;
  }

  function sanLine(fen, sans) {
    const p = fen.split(" ");
    let no = +(p[5] || 1), w = p[1] === "w";
    const out = [];
    sans.forEach((s, i) => {
      if (w) out.push(no + "." + s); else out.push(i === 0 ? no + "..." + s : s);
      if (!w) no++;
      w = !w;
    });
    return out.join(" ");
  }

  class SFEngine {
    constructor(opt = {}) {
      this.script = opt.script || "stockfish-18-lite-single.js";
      this.Chess = opt.Chess || root.Chess || null;     // 表記に直す用（任意）
      this.maxSan = opt.maxSan || 12;
      this.w = null; this.ready = false;
      this.fen = null; this.lines = {}; this.depth = 0;
      this.searching = false; this.pending = null; this.job = null;
      this.onUpdate = null;
      this._t = null;
    }

    init() {
      if (this._init) return this._init;
      this._init = new Promise((resolve, reject) => {
        try { this.w = new Worker(this.script); }
        catch (e) { reject(new Error("エンジンを起動できませんでした: " + e.message)); return; }
        this.w.onerror = (e) => reject(new Error("エンジンのエラー: " + (e.message || "")));
        this.w.onmessage = (e) => this._line(String(e.data), resolve);
        this.w.postMessage("uci");
      });
      return this._init;
    }

    _line(line, resolve) {
      if (line === "uciok") { this.w.postMessage("isready"); return; }
      if (line === "readyok" && !this.ready) { this.ready = true; resolve(this); return; }
      if (line.startsWith("bestmove")) { this._done(); return; }
      if (!line.startsWith("info") || !this.searching) return;
      const m = line.match(/ depth (\d+).*? multipv (\d+) .*?score (cp|mate) (-?\d+).*? pv (.+)$/)
             || line.match(/ depth (\d+).*?score (cp|mate) (-?\d+).*? pv (.+)$/);
      if (!m) return;
      let depth, k, kind, val, pv;
      if (m.length === 6) [, depth, k, kind, val, pv] = m; else { [, depth, kind, val, pv] = m; k = 1; }
      const sign = this.fen.split(" ")[1] === "w" ? 1 : -1;      // 手番側から見た値 → 白から見た値
      const l = { k: +k, depth: +depth, pv: pv.trim().split(/\s+/), cp: null, mate: null };
      if (kind === "cp") l.cp = sign * +val; else l.mate = sign * +val;
      this.lines[+k] = l;
      this.depth = Math.max(this.depth, +depth);
      if (this.onUpdate && !this._t) this._t = setTimeout(() => { this._t = null; this._emit(); }, 250);
    }

    _start(fen, o) {
      this.fen = fen; this.lines = {}; this.depth = 0; this.searching = true;
      this.w.postMessage("setoption name MultiPV value " + (o.multipv || 3));
      this.w.postMessage("position fen " + fen);
      let go = "go movetime " + (o.movetime || 20000);
      if (o.depth) go = "go depth " + o.depth;
      if (o.searchmoves && o.searchmoves.length) go += " searchmoves " + o.searchmoves.join(" ");
      this.w.postMessage(go);
      this._emit();
    }

    _done() {
      this.searching = false;
      const job = this.job; this.job = null;
      if (job && job.resolve) job.resolve(this.result());
      if (this.pending) { const p = this.pending; this.pending = null; this.job = p.job; this._start(p.fen, p.o); }
      else this._emit();
    }

    // 調べ始める（前の調べ中なら止めてから）
    _run(fen, o, job) {
      if (!this.ready) throw new Error("init() を待ってから使ってください");
      if (this.searching) {
        if (this.job && this.job.resolve) this.job.resolve(null);      // 前の evaluate は null で終わる
        this.pending = { fen, o, job }; this.job = null;
        this.w.postMessage("stop");
        return;
      }
      this.job = job;
      this._start(fen, o);
    }

    analyze(fen, o = {}) { this._run(fen, o, {}); }

    evaluate(fen, o = {}) {
      return new Promise((resolve) => this._run(fen, { movetime: 3000, ...o }, { resolve }));
    }

    stop() { this.pending = null; if (this.searching) this.w.postMessage("stop"); }

    result() {
      const fen = this.fen;
      const lines = Object.keys(this.lines).map(Number).sort((a, b) => a - b).map((k) => {
        const l = { ...this.lines[k] };
        l.san = this.toSan(fen, l.pv.slice(0, this.maxSan));
        l.text = evalText(l);
        l.line = l.san.length ? sanLine(fen, l.san) : l.pv.slice(0, 8).join(" ");
        return l;
      });
      return { fen, depth: this.depth, searching: this.searching, lines };
    }

    _emit() { if (this.onUpdate && this.fen) this.onUpdate(this.result()); }

    // UCI の手順を SAN に（chess.js が無ければ空配列）
    toSan(fen, ucis) {
      const out = [];
      if (!this.Chess) return out;
      try {
        const g = new this.Chess(fen);
        for (const u of ucis) {
          const mv = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });  // 新しい chess.js は不正な手で例外
          if (!mv) break;
          out.push(mv.san);
        }
      } catch (e) { /* そこまでの手順を返す */ }
      return out;
    }

    terminate() { if (this.w) this.w.terminate(); this.w = null; this.ready = false; this._init = null; }
  }

  SFEngine.evalText = evalText;
  SFEngine.forSide = forSide;
  SFEngine.score = score;
  SFEngine.sanLine = sanLine;
  root.SFEngine = SFEngine;
  if (typeof module !== "undefined") module.exports = SFEngine;
})(typeof window !== "undefined" ? window : globalThis);
