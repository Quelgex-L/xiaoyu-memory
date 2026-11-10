// Ollama 与 embedding 模型连通性自检（npm run health）
// 未就绪时插件会降级为本地哈希向量，不影响主流程；这里仅给出明确提示。
import { checkOllama } from "../src/store/embedding.js";
import { getConfig } from "../src/config.js";

const cfg = getConfig();
const ok = await checkOllama();

if (ok) {
  console.log(`✔ Ollama 可用，embedding 模型：${cfg.ollama.embeddingModel}`);
  process.exit(0);
}

console.error(
  `✖ Ollama 不可用或缺少模型 ${cfg.ollama.embeddingModel}（baseUrl: ${cfg.ollama.baseUrl}）。` +
    `未就绪时插件将降级为哈希向量，不阻塞对话。`
);
process.exit(1);
