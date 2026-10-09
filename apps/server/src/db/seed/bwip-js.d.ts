// У bwip-js типы лежат за условиями экспорта, которые наш разрешитель модулей не выбирает. Нужен только toSVG.
declare module 'bwip-js' {
  const bwipjs: { toSVG(options: Record<string, unknown>): string };
  export default bwipjs;
}
