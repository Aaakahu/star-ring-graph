// 让 TS 认得 esbuild text loader 内联的 .md 资源
declare module "*.md" {
  const content: string;
  export default content;
}
