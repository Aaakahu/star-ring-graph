// font-loader.ts - 三插件同构
// 从插件 fonts/ 目录加载 woff2 字体，注册为 @font-face。
// 加载失败静默回退系统字体，不阻塞插件启动。

export async function loadPluginFonts(plugin: any): Promise<void> {
  // 守卫：如果已经注册过，跳过
  if (document.fonts.check('16px "Sring UI Sans"')) return;

  const fontDir = plugin.manifest.dir;
  const adapter = plugin.app.vault.adapter;

  // 字体文件列表与 family 映射
  const fonts = [
    { files: ['inter-400.woff2', 'inter-500.woff2', 'inter-600.woff2'], family: 'Sring UI Sans' },
    { files: ['noto-sc-400.woff2', 'noto-sc-700.woff2'], family: 'Sring UI Sans' },
    { files: ['jbmono-400.woff2', 'jbmono-600.woff2'], family: 'Sring UI Mono' },
  ];

  for (const { files, family } of fonts) {
    for (const file of files) {
      try {
        const path = fontDir + '/fonts/' + file;
        const data = await adapter.readBinary(path);
        // ponytail: Blob URL 直接引用 ArrayBuffer（零拷贝零转码），替代旧版逐字节 base64 拼接
        //（1.4MB 字体 ≈ 上百万次字符串连接，全在主线程）。不 revoke：@font-face 引用期间必须有效。
        const url = URL.createObjectURL(new Blob([data], { type: 'font/woff2' }));

        // 提取 weight（每个文件对应一个 weight）
        const w = file.match(/(\d+)\.woff2/)?.[1] || '400';

        const style = document.createElement('style');
        style.textContent = `@font-face { font-family: "${family}"; src: url("${url}"); font-weight: ${w}; font-display: swap; }`;
        document.head.appendChild(style);
      } catch (e) {
        // 静默失败，回退系统字体
        console.warn(`[font-loader] Failed to load ${file}:`, e);
      }
    }
  }
}
