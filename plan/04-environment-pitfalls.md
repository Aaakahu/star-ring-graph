# 环境踩坑记录（必读，避免重蹈）

> 上次集成在环境调试上花了大量时间。这些坑都已确认，本次直接绕过。

## 坑 1：Python 来源（最关键）

**症状**：`pip install` 装 numpy 时报 `metadata-generation-failed`，从源码编译失败。

**根因**：本机 `python` 命令指向 **MSYS2 mingw64 版 Python**（GCC 编译）：
```
$ python -c "import sys; print(sys.executable)"
C:/msys64/mingw64/bin/python.exe
$ python -c "import sys; print(sys.version)"
Python 3.12.12 ... [GCC 15.2.0 64 bit (AMD64)]  ← GCC 编译，不是 MSVC
```

PyPI 的 numpy/tiktoken 预编译 wheel 是给**官方 MSVC 版 Python** 的（平台标签 `win_amd64`）。
MSYS2 的 GCC 版 Python 平台标签不同，pip 找不到 wheel，只能从源码编译，而源码编译要本地工具链（Meson + Ninja + GCC 配置），在 pip 的隔离 build 环境里检测不到。

**解决**：用官方 Windows Python。本机有：
```
C:/Users/34547/AppData/Local/Programs/Python/Python311/python.exe  ← 官方 MSVC 版 3.11.9
C:/Users/34547/AppData/Local/Programs/Python/Python310/python.exe  ← 官方 3.10
C:/Users/34547/AppData/Local/Programs/Python/Python39/python.exe   ← 官方 3.9
```

**用 Python 3.11**（lightrag-hku 要求 3.10-3.13）：
```bash
PY="C:/Users/34547/AppData/Local/Programs/Python/Python311/python.exe"
"$PY" -m venv lightrag/venv
lightrag/venv/Scripts/python.exe -m pip install "lightrag-hku[api]"
```

**判断标志**：官方 venv 建出来是 `Scripts/` 目录，MSYS2 的是 `bin/` 目录。

## 坑 2：PyPI 包名

**症状**：`pip install lightrag[api]` 装完发现没有 API server（`import lightrag.api` 报 ModuleNotFoundError）。

**根因**：PyPI 上 `lightrag` 是 **SylphAI-Inc** 的另一个同名项目（"Lightning Library for LLM Applications"），不是 HKUDS/LightRAG。

**解决**：正确包名是 **`lightrag-hku`**（HKUDS/LightRAG 的官方 PyPI 发布）：
```bash
pip install "lightrag-hku[api]"  # 不是 lightrag[api]
```

当前最新版 1.5.4，含完整 API server + WebUI。

## 坑 3：pacman 在 Git Bash 失效

**症状**：`pacman -S` 报 `failed to init transaction (unable to lock database)`，清锁后还报。

**根因**：当前 shell 是 Git Bash（`/bin/bash.exe`，MINGW64），不是完整 MSYS2。
Git Bash 没有 `/etc/pacman.conf`，pacman 找不到配置，database 路径与实际 MSYS2 安装对不上。
MSYS2 自己的 bash（`C:/msys64/usr/bin/bash.exe`）能正常用 pacman，但 Git Bash 不行。

**解决**：**放弃 pacman 路线**。不要试图在 Git Bash 里用 pacman 装 mingw 预编译包。
直接用官方 Python 3.11 的 pip，PyPI 的预编译 wheel 全部可用，不需要 pacman。

## 坑 4：.env 环境变量名

**症状**：在 `.env` 写 `LLM_BASE_URL=https://open.bigmodel.cn/...`，server 启动后 `llm_binding_host` 仍是 `https://api.openai.com/v1`（默认值）。

**根因**：lightrag-hku 1.5.4 的 `config.py` 用的变量名是 **`LLM_BINDING_HOST`**，不是 `LLM_BASE_URL`：
```python
# lightrag/config.py:76
"openai": os.getenv("LLM_BINDING_HOST", "https://api.openai.com/v1"),
```

**解决**：.env 用正确的变量名：
```env
LLM_BINDING_HOST=https://open.bigmodel.cn/api/paas/v4     # 不是 LLM_BASE_URL
EMBEDDING_BINDING_HOST=https://open.bigmodel.cn/api/paas/v4  # 不是 EMBEDDING_BASE_URL
LLM_BINDING=openai
EMBEDDING_BINDING=openai
LLM_API_KEY=<key>
LLM_MODEL=glm-4.5
EMBEDDING_MODEL=embedding-3
```

## 坑 5：venv 不继承系统 site-packages

**症状**：用 pacman 在系统 mingw64 Python 装了 numpy，但 venv 里 `import numpy` 报 ModuleNotFoundError。

**根因**：venv 默认隔离，不继承系统 site-packages。这是 venv 的设计，不是 bug。

**解决**：**这条坑只在 MSYS2 路线下出现**。用官方 Python 3.11 后不存在此问题——pip 直接在 venv 内装 numpy 1.26.4 的预编译 wheel，4 秒搞定。

## 坑 6：LightRAG HTTP 不支持请求级 LLM 覆盖

**症状**：想在 `/query` 请求体里传 `llm_api_key`，让 server 用插件面板的 key 而非 .env 的。

**根因**：`QueryRequest` 的 schema 里没有 `llm_api_key`/`llm_base_url` 字段。server 启动时构造唯一一个 `LightRAG` 实例，LLM 绑死，请求体任何字段都不会重建它。
（确认来源：读 `lightrag/api/routers/query_routes.py` 和 `lightrag/api/lightrag_server.py` 源码）

**解决**：方案 B（插件写 .env + 重启 server）。插件面板填 key → 点"应用并重启" → 写 `.env` → spawn `restart.sh`。

---

## 一句话总结

**用官方 Python 3.11（`AppData/Local/Programs/Python/Python311/`）+ `pip install lightrag-hku[api]` + `.env` 用 `LLM_BINDING_HOST` 变量名**。这四件事做对，环境就不会卡。
