/**
 * 内置示例：一个会产生焦点陷阱的小图。
 *
 * - 最短到目标：Tab, Tab（gate → hall → vault，vault 仅在 lamp 关时可见）
 * - 最短陷阱前缀：Tab, 激活（hall 上激活翻转 lamp 并跳到 cell，
 *   lamp 一旦打开就再也关不上，vault 永远隐藏）
 */
export const SAMPLE_TEXT = `{
  "nodes": ["gate", "hall", "vault", "cell", "mirror"],
  "switches": ["lamp"],
  "entry": "gate",
  "target": "vault",
  "conditions": {
    "vault": [["lamp", false]],
    "cell": [["lamp", true]],
    "mirror": [["lamp", true]]
  },
  "edges": {
    "gate":   { "tab": "hall", "shiftTab": "hall" },
    "hall":   { "tab": "vault", "activate": { "to": "cell", "flip": "lamp" } },
    "vault":  { "tab": "gate" },
    "cell":   { "tab": "hall", "activate": "mirror" },
    "mirror": { "tab": "gate" }
  }
}
`;
