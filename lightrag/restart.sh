#!/bin/bash
# LightRAG server 重启脚本 — 由插件"应用并重启"按钮调用
# 用法: bash restart.sh
# 作用: 杀掉已在跑的 lightrag server → 重新读取 .env → 后台启动新实例

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PIDFILE="./lightrag.pid"
LOGFILE="./lightrag.log"
PORT=9620

echo "=== 停止旧的 LightRAG server ==="

# 方法1：用 PID 文件
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "杀进程 PID=$OLD_PID"
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
fi

# 方法2：兜底，按端口找进程
PID_BY_PORT=$(netstat -ano 2>/dev/null | grep ":$PORT " | grep "LISTENING" | awk '{print $NF}' | head -1)
if [ -n "$PID_BY_PORT" ]; then
  echo "端口 $PORT 被占用 (PID=$PID_BY_PORT)，taskkill"
  taskkill //F //PID "$PID_BY_PORT" 2>/dev/null || true
  sleep 2
fi

echo ""
echo "=== 启动新 LightRAG server ==="

# 后台启动，日志写文件，PID 存 pidfile
nohup ./venv/Scripts/lightrag-server.exe --host 127.0.0.1 --port $PORT > "$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"
echo "新进程 PID=$NEW_PID"
echo "日志: $LOGFILE"

# 等 server 起来（最多 30 秒）
echo ""
echo "=== 等待 server 就绪 ==="
for i in $(seq 1 30); do
  if curl -s "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "server 已就绪（耗时 ${i}s）"
    echo ""
    echo "=== 健康检查 ==="
    curl -s "http://127.0.0.1:$PORT/health" | head -c 200
    echo ""
    exit 0
  fi
  sleep 1
  printf "."
done

echo ""
echo "server 30 秒内未就绪，查看日志: $LOGFILE"
echo "=== 日志尾部 ==="
tail -20 "$LOGFILE"
exit 1
