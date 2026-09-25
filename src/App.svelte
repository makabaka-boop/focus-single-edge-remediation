<script lang="ts">
  import {
    ACTION_ORDER,
    parseGraph,
    visible,
    type ActionKind,
    type FocusGraph,
  } from './lib/model';
  import {
    bitsOf,
    isDeadEdge,
    nodeOf,
    shortestToTarget,
    startState,
    stateOf,
    trapPrefix,
    type Witness,
  } from './lib/search';
  import { SAMPLE_TEXT } from './lib/sample';

  const ACTION_LABEL: Record<ActionKind, string> = {
    tab: 'Tab',
    shiftTab: 'Shift+Tab',
    activate: 'Enter',
  };
  const ACTION_COLOR: Record<ActionKind, string> = {
    tab: '#2563eb',
    shiftTab: '#7c3aed',
    activate: '#d97706',
  };

  // ---- 导入（非法导入不覆盖当前图） ----
  const initial = parseGraph(SAMPLE_TEXT);
  let importText = SAMPLE_TEXT;
  let importErrors: string[] = [];
  let importNotice = initial.ok ? '已载入内置示例' : '';
  let graph: FocusGraph | null = initial.ok ? initial.graph : null;

  // ---- 搜索结果 ----
  let witness: Witness | null = null;
  let witnessSearched = false;
  let trap: Witness | null = null;
  let trapSearched = false;

  // ---- 回放 ----
  let activeSeq: 'witness' | 'trap' = 'witness';
  let step = 0;

  function resetAnalysis() {
    witness = null;
    witnessSearched = false;
    trap = null;
    trapSearched = false;
    activeSeq = 'witness';
    step = 0;
  }

  function doImport() {
    const r = parseGraph(importText);
    if (r.ok) {
      graph = r.graph;
      importErrors = [];
      importNotice = `已导入：${r.graph.nodes.length} 个节点 / ${r.graph.switches.length} 个开关`;
      resetAnalysis();
    } else {
      // 非法导入：只展示错误，当前图保持不变
      importErrors = r.errors;
      importNotice = '';
    }
  }

  function runWitness() {
    if (!graph) return;
    witness = shortestToTarget(graph);
    witnessSearched = true;
    activeSeq = 'witness';
    step = 0;
  }

  function runTrap() {
    if (!graph) return;
    trap = trapPrefix(graph);
    trapSearched = true;
    activeSeq = 'trap';
    step = 0;
  }

  // ---- 派生状态 ----
  $: seq = activeSeq === 'witness' ? witness : trap;
  $: maxStep = seq ? seq.actions.length : 0;
  $: curState = graph
    ? seq
      ? seq.states[Math.min(step, maxStep)]
      : startState(graph)
    : -1;
  $: curNode = graph && curState >= 0 ? nodeOf(graph, curState) : -1;
  $: curBits = graph && curState >= 0 ? bitsOf(graph, curState) : 0;
  $: takenAction = seq && step < maxStep ? seq.actions[step] : null;
  $: takenFromNode = graph && seq && step < maxStep ? nodeOf(graph, seq.states[step]) : -1;

  $: bitsText = graph
    ? graph.switches.length === 0
      ? '（无开关）'
      : graph.switches.map((s, i) => `${s}=${(curBits >> i) & 1 ? '开' : '关'}`).join('，')
    : '';

  $: deadHere =
    graph && curNode >= 0
      ? ACTION_ORDER.filter((a) => isDeadEdge(graph!, curState, a)).map((a) => ({
          action: a,
          to: graph!.edges[curNode][a]!.to,
        }))
      : [];

  function condText(g: FocusGraph, i: number): string {
    const lits = g.conditions[i];
    if (lits.length === 0) return '总是';
    return lits.map((l) => (l.value ? g.switches[l.sw] : `¬${g.switches[l.sw]}`)).join(' ∧ ');
  }

  // ---- SVG 布局 ----
  const W = 680;
  const H = 540;
  const CX = W / 2;
  const CY = H / 2 + 6;
  const R = 195;
  const NR = 22;

  interface EdgeView {
    from: number;
    to: number;
    action: ActionKind;
    flip: number | null;
  }
  interface EdgeGeom extends EdgeView {
    self: boolean;
    d: string;
    lx: number;
    ly: number;
    cx: number;
    cy: number;
    r: number;
  }

  $: positions = graph
    ? graph.nodes.map((_, i) => {
        const a = -Math.PI / 2 + (2 * Math.PI * i) / graph!.nodes.length;
        return { x: CX + R * Math.cos(a), y: CY + R * Math.sin(a) };
      })
    : [];

  $: edgeGeoms = graph ? buildEdgeGeoms(graph, positions) : [];

  function buildEdgeGeoms(g: FocusGraph, pos: Array<{ x: number; y: number }>): EdgeGeom[] {
    const out: EdgeGeom[] = [];
    g.nodes.forEach((_, from) => {
      for (const action of ACTION_ORDER) {
        const e = g.edges[from][action];
        if (!e) continue;
        const aIdx = ACTION_ORDER.indexOf(action);
        const p1 = pos[from];
        const p2 = pos[e.to];
        if (from === e.to) {
          const ang = Math.atan2(p1.y - CY, p1.x - CX);
          const cx = p1.x + Math.cos(ang) * (NR + 18);
          const cy = p1.y + Math.sin(ang) * (NR + 18);
          out.push({ from, to: e.to, action, flip: e.flip, self: true, d: '', lx: cx, ly: cy - 22, cx, cy, r: 15 });
          continue;
        }
        const dx = p2.x - p1.x;
        const dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len;
        const ny = dx / len;
        const sign = from < e.to ? 1 : -1;
        const bend = sign * (0.14 + 0.09 * aIdx) * len;
        const cx = (p1.x + p2.x) / 2 + nx * bend;
        const cy = (p1.y + p2.y) / 2 + ny * bend;
        const pt = (t: number) => {
          const u = 1 - t;
          return { x: u * u * p1.x + 2 * t * u * cx + t * t * p2.x, y: u * u * p1.y + 2 * t * u * cy + t * t * p2.y };
        };
        let t0 = 0;
        let t1 = 1;
        for (let t = 0; t <= 1; t += 0.02) {
          const q = pt(t);
          if (Math.hypot(q.x - p1.x, q.y - p1.y) >= NR + 3) {
            t0 = t;
            break;
          }
        }
        for (let t = 1; t >= 0; t -= 0.02) {
          const q = pt(t);
          if (Math.hypot(q.x - p2.x, q.y - p2.y) >= NR + 7) {
            t1 = t;
            break;
          }
        }
        const s = pt(t0);
        const en = pt(t1);
        const mid = pt(0.5);
        out.push({
          from,
          to: e.to,
          action,
          flip: e.flip,
          self: false,
          d: `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${en.x.toFixed(1)} ${en.y.toFixed(1)}`,
          lx: mid.x,
          ly: mid.y,
          cx: 0,
          cy: 0,
          r: 0,
        });
      }
    });
    return out;
  }

  function edgeStatus(e: EdgeView): 'taken' | 'dead' | 'normal' {
    if (!graph || curState < 0) return 'normal';
    if (takenFromNode === e.from && takenAction === e.action) return 'taken';
    return isDeadEdge(graph, stateOf(graph, e.from, curBits), e.action) ? 'dead' : 'normal';
  }

  function edgeStroke(e: EdgeView): string {
    const st = edgeStatus(e);
    if (st === 'taken') return '#16a34a';
    if (st === 'dead') return '#dc2626';
    return ACTION_COLOR[e.action];
  }

  function edgeMarker(e: EdgeView): string {
    const st = edgeStatus(e);
    if (st === 'taken') return 'ar-taken';
    if (st === 'dead') return 'ar-dead';
    return `ar-${e.action}`;
  }

  function flipSuffix(g: FocusGraph, flip: number | null): string {
    return flip === null ? '' : ` ⇄${g.switches[flip]}`;
  }
</script>

<main>
  <h1>焦点流程实验台</h1>
  <p class="hint">
    条件控件会让键盘用户掉进局部焦点陷阱：以（焦点节点，开关位集）为状态，
    搜索到目标的最短按键序列，以及从入口可达却再也无法抵达目标的最短陷阱前缀。
  </p>

  <section class="panel">
    <h2>1 · 导入图定义</h2>
    <textarea bind:value={importText} rows="14" spellcheck="false" aria-label="图定义 JSON"></textarea>
    <div class="row">
      <button on:click={doImport}>导入</button>
      <button on:click={() => (importText = SAMPLE_TEXT)}>填入示例</button>
      {#if importNotice}<span class="ok">{importNotice}</span>{/if}
    </div>
    {#if importErrors.length > 0}
      <ul class="errors">
        {#each importErrors as e}
          <li>{e}</li>
        {/each}
      </ul>
      <p class="warn">导入被拒绝，当前图保持不变。</p>
    {/if}
  </section>

  {#if graph}
    <section class="panel">
      <h2>2 · 当前图 <small>（{graph.nodes.length} 节点 / {graph.switches.length} 开关）</small></h2>
      <div class="row switches">
        <span class="muted">开关：</span>
        {#each graph.switches as sw, i}
          <span class="pill" class:on={((curBits >> i) & 1) === 1}>
            {sw} · {((curBits >> i) & 1) === 1 ? '开' : '关'}
          </span>
        {/each}
        {#if graph.switches.length === 0}<span class="muted">（无）</span>{/if}
      </div>

      <svg viewBox="0 0 {W} {H}" role="img" aria-label="焦点转移图">
        <defs>
          <marker id="ar-tab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#2563eb" />
          </marker>
          <marker id="ar-shiftTab" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#7c3aed" />
          </marker>
          <marker id="ar-activate" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#d97706" />
          </marker>
          <marker id="ar-dead" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#dc2626" />
          </marker>
          <marker id="ar-taken" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#16a34a" />
          </marker>
        </defs>

        {#each edgeGeoms as e}
          {@const st = edgeStatus(e)}
          {#if e.self}
            <circle
              cx={e.cx}
              cy={e.cy}
              r={e.r}
              fill="none"
              stroke={edgeStroke(e)}
              stroke-width={st === 'normal' ? 1.6 : 3.2}
              stroke-dasharray={st === 'dead' ? '5 4' : 'none'}
            />
            <text x={e.lx} y={e.ly} class="elabel" fill={edgeStroke(e)}>
              {ACTION_LABEL[e.action]}{flipSuffix(graph, e.flip)}
            </text>
          {:else}
            <path
              d={e.d}
              fill="none"
              stroke={edgeStroke(e)}
              stroke-width={st === 'normal' ? 1.6 : 3.2}
              stroke-dasharray={st === 'dead' ? '6 4' : 'none'}
              marker-end="url(#{edgeMarker(e)})"
            />
            <text x={e.lx} y={e.ly} class="elabel" fill={edgeStroke(e)}>
              {ACTION_LABEL[e.action]}{flipSuffix(graph, e.flip)}
            </text>
          {/if}
        {/each}

        {#each graph.nodes as name, i}
          {@const p = positions[i]}
          {@const hidden = !visible(graph, i, curBits)}
          <g opacity={hidden ? 0.35 : 1}>
            <circle
              cx={p.x}
              cy={p.y}
              r={NR}
              fill={i === curNode ? '#dcfce7' : i === graph.target ? '#fef9c3' : '#ffffff'}
              stroke={i === curNode ? '#16a34a' : i === graph.target ? '#ca8a04' : '#64748b'}
              stroke-width={i === curNode ? 3.5 : 1.6}
              stroke-dasharray={hidden ? '4 3' : 'none'}
            />
            <text x={p.x} y={p.y + NR + 15} text-anchor="middle" class="nlabel">{name}</text>
            {#if i === graph.entry || i === graph.target}
              <text x={p.x} y={p.y - NR - 7} text-anchor="middle" class="tag">
                {i === graph.entry ? '入口' : '目标'}
              </text>
            {/if}
          </g>
        {/each}
      </svg>

      <table>
        <thead>
          <tr><th>节点</th><th>可见条件</th><th>Tab</th><th>Shift+Tab</th><th>激活</th></tr>
        </thead>
        <tbody>
          {#each graph.nodes as name, i}
            <tr class:cur={i === curNode} class:dim={!visible(graph, i, curBits)}>
              <td>
                {name}
                {#if i === graph.entry}<span class="badge">入口</span>{/if}
                {#if i === graph.target}<span class="badge goal">目标</span>{/if}
              </td>
              <td class="mono">{condText(graph, i)}</td>
              {#each ACTION_ORDER as a}
                {@const e = graph.edges[i][a]}
                <td
                  class="mono"
                  class:dead={e !== null && isDeadEdge(graph, stateOf(graph, i, curBits), a)}
                >
                  {#if e}
                    {graph.nodes[e.to]}{e.flip !== null ? `（翻转 ${graph.switches[e.flip]}）` : ''}
                  {:else}
                    —
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="legend">
        <span style="color:#2563eb">— Tab</span>
        <span style="color:#7c3aed">— Shift+Tab</span>
        <span style="color:#d97706">— 激活</span>
        <span style="color:#dc2626">- - 失效边（当前开关位下目标隐藏）</span>
        <span style="color:#16a34a">— 回放中走过的边</span>
      </p>
    </section>

    <section class="panel">
      <h2>3 · 状态搜索</h2>
      <div class="row">
        <button on:click={runWitness}>搜索：到目标的最短按键序列</button>
        <button on:click={runTrap}>搜索：最短陷阱前缀</button>
      </div>
      {#if witnessSearched}
        {#if witness}
          <p class="ok">
            ✅ 最短 {witness.actions.length} 键到达目标：
            {#each witness.actions as a}<code>{ACTION_LABEL[a]}</code>{' '}{/each}
            <button class="mini" on:click={() => ((activeSeq = 'witness'), (step = 0))}>回放</button>
          </p>
        {:else}
          <p class="warn">❌ 目标不可达：从入口出发无法聚焦到目标节点。</p>
        {/if}
      {/if}
      {#if trapSearched}
        {#if trap}
          <p class="warn">
            ⚠️ 最短陷阱前缀 {trap.actions.length} 键：
            {#each trap.actions as a}<code>{ACTION_LABEL[a]}</code>{' '}{/each}
            {#if trap.actions.length === 0}（空序列：入口状态本身即陷阱）{/if}
            —— 执行后目标永不可达。
            <button class="mini" on:click={() => ((activeSeq = 'trap'), (step = 0))}>回放</button>
          </p>
        {:else}
          <p class="ok">✅ 无陷阱：入口可达的每个状态都仍能到达目标。</p>
        {/if}
      {/if}
    </section>

    {#if seq}
      <section class="panel">
        <h2>4 · 逐键回放 <small>（{activeSeq === 'witness' ? '到目标见证' : '陷阱前缀'}）</small></h2>
        <div class="chips">
          {#each seq.actions as a, i}
            <span class="chip" class:done={i < step} class:now={i === step}>{ACTION_LABEL[a]}</span>
          {/each}
          {#if seq.actions.length === 0}<span class="muted">（空序列）</span>{/if}
        </div>
        <div class="row">
          <button on:click={() => (step = 0)} disabled={step === 0}>⏮ 重置</button>
          <button on:click={() => (step = Math.max(0, step - 1))} disabled={step === 0}>◀ 撤销一键</button>
          <button on:click={() => (step = Math.min(maxStep, step + 1))} disabled={step >= maxStep}>
            ▶ 按下一键{step < maxStep ? `（${ACTION_LABEL[seq.actions[step]]}）` : ''}
          </button>
          <span class="muted">进度 {step} / {maxStep}</span>
        </div>
        <p>
          当前焦点：<b>{graph.nodes[curNode]}</b>　开关：<span class="mono">{bitsText}</span>
        </p>
        {#if deadHere.length > 0}
          <p class="warn">
            当前节点失效边：
            {#each deadHere as d}
              <code>{graph.nodes[curNode]} —{ACTION_LABEL[d.action]}→ {graph.nodes[d.to]}</code>{' '}
            {/each}
          </p>
        {/if}
      </section>
    {/if}
  {/if}
</main>

<style>
  :global(body) {
    margin: 0;
    background: #f1f5f9;
    color: #0f172a;
    font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  }
  main {
    max-width: 880px;
    margin: 0 auto;
    padding: 24px 16px 64px;
  }
  h1 {
    font-size: 1.5rem;
    margin: 0 0 4px;
  }
  h2 {
    font-size: 1.05rem;
    margin: 0 0 10px;
  }
  h2 small {
    color: #64748b;
    font-weight: normal;
  }
  .hint {
    color: #475569;
    margin: 0 0 16px;
    font-size: 0.9rem;
  }
  .panel {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 16px;
  }
  textarea {
    width: 100%;
    box-sizing: border-box;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.82rem;
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 8px;
    resize: vertical;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  button {
    border: 1px solid #cbd5e1;
    background: #f8fafc;
    border-radius: 6px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 0.88rem;
  }
  button:hover:not(:disabled) {
    background: #e2e8f0;
  }
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button.mini {
    padding: 2px 10px;
    font-size: 0.78rem;
  }
  .ok {
    color: #15803d;
  }
  .warn {
    color: #b45309;
  }
  .errors {
    color: #b91c1c;
    font-size: 0.85rem;
    margin: 8px 0 0;
    padding-left: 20px;
  }
  .muted {
    color: #94a3b8;
  }
  .mono {
    font-family: ui-monospace, Consolas, monospace;
    font-size: 0.85rem;
  }
  .switches {
    margin: 0 0 8px;
  }
  .pill {
    border: 1px solid #cbd5e1;
    border-radius: 999px;
    padding: 2px 12px;
    font-size: 0.8rem;
    background: #f8fafc;
  }
  .pill.on {
    background: #fef3c7;
    border-color: #d97706;
    color: #92400e;
  }
  svg {
    width: 100%;
    height: auto;
    background: #fbfdff;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
  }
  .nlabel {
    font-size: 12px;
    fill: #334155;
  }
  .elabel {
    font-size: 10.5px;
    text-anchor: middle;
    paint-order: stroke;
    stroke: #fbfdff;
    stroke-width: 3px;
  }
  .tag {
    font-size: 10px;
    fill: #b45309;
    font-weight: 600;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 12px;
    font-size: 0.85rem;
  }
  th,
  td {
    border: 1px solid #e2e8f0;
    padding: 5px 8px;
    text-align: left;
  }
  th {
    background: #f8fafc;
  }
  tr.cur td {
    background: #f0fdf4;
  }
  tr.dim td {
    opacity: 0.45;
  }
  td.dead {
    color: #dc2626;
    font-weight: 600;
    background: #fef2f2;
  }
  .badge {
    font-size: 0.68rem;
    border-radius: 4px;
    padding: 1px 5px;
    margin-left: 4px;
    background: #e0e7ff;
    color: #3730a3;
  }
  .badge.goal {
    background: #fef9c3;
    color: #854d0e;
  }
  .legend {
    display: flex;
    gap: 16px;
    flex-wrap: wrap;
    font-size: 0.8rem;
    margin: 10px 0 0;
  }
  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 4px;
  }
  .chip {
    border: 1px solid #cbd5e1;
    border-radius: 6px;
    padding: 3px 10px;
    font-size: 0.82rem;
    background: #f8fafc;
  }
  .chip.done {
    background: #dcfce7;
    border-color: #16a34a;
    color: #15803d;
  }
  .chip.now {
    background: #1d4ed8;
    border-color: #1d4ed8;
    color: #fff;
    font-weight: 700;
  }
  code {
    background: #f1f5f9;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 0.82rem;
  }
</style>
