/**
 * GitHub 代理候选清单的读写（与工具、候选 JSON 共用）
 *
 * 为什么候选要落文件而不是写死在代码里：代理站会挂、会换域名，把清单放进
 * `candidates.json` 就能直接改，不用改代码；工具显式传进来的地址也会写回这份清单，
 * 下次可以不带参数直接用，失败次数也记在这里（达到阈值置 `disabled`，避免每次都先撞一遍死代理）。
 *
 * 文件：与本模块同目录的 `candidates.json`（随仓库入库）。
 * 写入策略：原子写（临时文件 + rename），写失败不影响调用方主流程。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 候选清单位置（与代码同目录，随仓库入库）。 */
export const CANDIDATES_PATH = join(HERE, 'candidates.json');

/** 连续失败多少次后自动停用（可在文件里手改单条 disabled 覆盖）。 */
export const MAX_FAILURES = 3;

/** 默认重写目标站点（可被候选条目或工具参数覆盖）。 */
export const DEFAULT_HOSTS = ['github.com'];

/** 归一化代理地址：去空白，补结尾斜杠（git 的 insteadOf 前缀必须能直接拼接）。 */
export function normalizeMirror(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  return text.endsWith('/') ? text : `${text}/`;
}

/** 归一化 host 列表：接受数组或逗号串，去空去重。 */
export function normalizeHosts(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const cleaned = list.map((h) => String(h).trim().replace(/^https?:\/\//i, '').replace(/\/$/, '')).filter(Boolean);
  return [...new Set(cleaned.length ? cleaned : DEFAULT_HOSTS)];
}

/** 读候选清单（坏 JSON / 文件不存在都当空清单，不崩）。 */
export function readCandidates(path = CANDIDATES_PATH) {
  try {
    if (!existsSync(path)) return [];
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(raw?.candidates) ? raw.candidates : [];
    return list
      .map((it) => ({
        mirror: normalizeMirror(it?.mirror),
        hosts: normalizeHosts(it?.hosts),
        disabled: it?.disabled === true,
        failures: Number.isFinite(Number(it?.failures)) ? Math.max(0, Math.trunc(Number(it.failures))) : 0,
        lastOkAt: it?.lastOkAt ?? null,
        lastError: it?.lastError ?? null,
        lastCheckedAt: it?.lastCheckedAt ?? null,
      }))
      .filter((it) => it.mirror);
  } catch {
    return [];
  }
}

/** 原子写候选清单（失败返回 ok:false，不抛）。 */
export function writeCandidates(list, path = CANDIDATES_PATH) {
  try {
    const payload = {
      version: 1,
      note: 'GitHub 代理候选清单。mirror 必须以 / 结尾；hosts 为要重写的目标站点。failures 为连续失败次数，达到上限置 disabled，可用 probe 重测后恢复。本文件随仓库入库，运行期会回写学习结果。',
      candidates: (Array.isArray(list) ? list : []).map((it) => ({
        mirror: normalizeMirror(it.mirror),
        hosts: normalizeHosts(it.hosts),
        disabled: it.disabled === true,
        failures: Math.max(0, Math.trunc(Number(it.failures) || 0)),
        lastOkAt: it.lastOkAt ?? null,
        lastError: it.lastError ?? null,
        lastCheckedAt: it.lastCheckedAt ?? null,
      })),
    };
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, path);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 把显式传入的代理并进清单（已存在则更新 hosts、不动失败计数）。
 * @returns {{list: object[], added: boolean}}
 */
export function mergeCandidate(list, mirror, hosts) {
  const normalized = normalizeMirror(mirror);
  const next = Array.isArray(list) ? [...list] : [];
  const index = next.findIndex((it) => normalizeMirror(it.mirror) === normalized);
  if (index >= 0) {
    next[index] = { ...next[index], hosts: normalizeHosts(hosts ?? next[index].hosts), disabled: false };
    return { list: next, added: false };
  }
  next.push({
    mirror: normalized,
    hosts: normalizeHosts(hosts),
    disabled: false,
    failures: 0,
    lastOkAt: null,
    lastError: null,
    lastCheckedAt: null,
  });
  return { list: next, added: true };
}

/**
 * 记录一次探测结果：成功清零失败计数，失败累加并在达到阈值时停用。
 * @returns {object[]} 新清单
 */
export function recordProbe(list, mirror, { ok, error = null, at = new Date().toISOString() } = {}) {
  const normalized = normalizeMirror(mirror);
  return (Array.isArray(list) ? list : []).map((it) => {
    if (normalizeMirror(it.mirror) !== normalized) return it;
    if (ok) {
      return { ...it, failures: 0, disabled: false, lastOkAt: at, lastError: null, lastCheckedAt: at };
    }
    const failures = Math.max(0, Math.trunc(Number(it.failures) || 0)) + 1;
    return {
      ...it,
      failures,
      disabled: failures >= MAX_FAILURES,
      lastError: String(error ?? 'probe failed').slice(0, 300),
      lastCheckedAt: at,
    };
  });
}

/** 可用候选（未停用），保持文件顺序。 */
export function usableCandidates(list) {
  return (Array.isArray(list) ? list : []).filter((it) => it.mirror && it.disabled !== true);
}
