import { basename, dirname } from 'node:path';
import { readLinesFrom } from './lines.js';
import { normalizeModel } from '../models.js';

/**
 * WorkBuddy / CodeBuddy 采集器：<root>/<dir>/<session>.jsonl（Electron 版 transcript）。
 * 两个产品同一套日志格式，CodeBuddy 源（~/.codebuddy/projects）复用本采集器。
 *
 * - usage 在记录的 message.usage（OpenAI 口径：input_tokens 已含 cache_read，
 *   实测 total = input + output）；CodeBuddy 另有一种 Anthropic 口径的 usage
 *   （input_tokens/output_tokens/cache_read_input_tokens）出现在部分记录里，字段名相同，取用方式一致；
 * - providerData 携带 model（真实名，如 glm-5.3-flash）与 traceId（轮次键，
 *   供 credit 对账与费率自学习）；CodeBuddy 的 providerData.agent 为 'cli' 时表示来自 CLI；
 * - 项目名从目录名解出，规则按源不同（见 projectFromDir）。
 */
function projectFromDir(fileDir, tool) {
  const name = basename(fileDir);
  if (tool === 'codebuddy') {
    // CodeBuddy 把 cwd 的 / 换成 - 作目录名：Users-<user>-projects-git-agent-prompt。
    // '-' 本身的歧义无法还原（agent-prompt 可能是 agent/prompt），只去掉用户前缀不做猜测。
    const m = name.match(/^Users-[^-]+-(.+)$/);
    return m ? m[1] : name;
  }
  const m = name.match(/-WorkBuddy-(.+)$/);
  return m ? m[1] : name;
}

export async function collectWorkbuddyFile(store, { tool, path, fileId, offset }) {
  let inserted = 0;
  // 用 dirname 而不是 lastIndexOf('/')：Windows 上分隔符是反斜杠，
  // 原写法找不到 '/' 会退化成 slice(0, -1)，把项目名切成文件名的残片
  const project = projectFromDir(dirname(path), tool);
  // dedup_key 是全局 UNIQUE：两个源共用采集器，键前缀必须分开，否则同 id 会互相顶掉。
  // workbuddy 保持 'wb' 不动，改前缀会让存量行在重扫时被重复插入。
  const keyPrefix = tool === 'codebuddy' ? 'cb' : 'wb';

  const { newOffset } = await readLinesFrom(path, offset, (line) => {
    if (!line.includes('"usage"')) return;
    let rec;
    try { rec = JSON.parse(line); } catch { return; }
    const u = rec?.message?.usage;
    if (!u || !rec.id || !Number.isFinite(rec.timestamp)) return;
    const inputRaw = u.input_tokens || 0;
    const cached = Math.min(u.cache_read_input_tokens || 0, inputRaw);
    const output = u.output_tokens || 0;
    if (inputRaw + output <= 0) return;

    const pd = rec.providerData || {};
    inserted += store.insertEvent({
      ts: rec.timestamp,
      tool,
      model: normalizeModel(pd.model),
      session_id: rec.sessionId || fileId,
      project,
      input_tokens: inputRaw - cached,
      cached_input: cached,
      cache_write: 0,
      output_tokens: output,
      reasoning_tokens: 0,
      total_tokens: inputRaw + output,
      dedup_key: `${keyPrefix}:${rec.id}`,
      trace_id: pd.traceId || null,
    });
  });

  return { newOffset, inserted };
}
