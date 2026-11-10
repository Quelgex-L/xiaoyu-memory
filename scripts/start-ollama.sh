#!/usr/bin/env bash
# 启动本地 Ollama 并预拉取本插件所需的 embedding / 任务模型。
set -euo pipefail

embed_model="${EMBED_MODEL:-nomic-embed-text}"
task_model="${TASK_MODEL:-qwen2.5:7b}"

if ! command -v ollama >/dev/null 2>&1; then
  echo "未检测到 ollama，请先安装：https://ollama.com" >&2
  exit 1
fi

# 后台拉起服务；若已在运行，serve 会自行退出。
ollama serve >/dev/null 2>&1 &
sleep 2

ollama pull "$embed_model"
ollama pull "$task_model"

echo "完成：$embed_model / $task_model 已就绪。"
