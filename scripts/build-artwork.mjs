import { mkdir, writeFile } from 'node:fs/promises'

const copy = {
  zh: {
    title: '少等摘要，多做一步。', subtitle: '提前准备上下文摘要，把压缩等待藏进工作的间隙。',
    before: '原版压缩', after: 'Faster Compress', request: '模型请求', tool: '工具执行', next: '继续推进',
    wait: '等待摘要生成', background: '后台准备摘要', commit: '就绪后，安全应用',
    footer: '达到准备线后后台生成 · 就绪即应用 · 默认无独立预热',
    note: '流程示意，非性能基准；未准备好时仍需等待。',
  },
  en: {
    title: 'Less waiting. More progress.', subtitle: 'Prepare context summaries while the agent keeps working.',
    before: 'Stock compaction', after: 'Faster Compress', request: 'Model request', tool: 'Tool execution', next: 'Keep working',
    wait: 'Wait for the summary', background: 'Prepare summary in background', commit: 'Apply when ready',
    footer: 'Start at the preparation threshold · Apply when ready · No separate warm-up by default',
    note: 'Illustration, not a benchmark. Unfinished summaries still require a wait.',
  },
}
const target = new URL('../assets/', import.meta.url)
await mkdir(target, { recursive: true })
for (const [language, t] of Object.entries(copy)) {
  const box = (x, y, w, label, fill = '#E8F0F4', color = '#244B5C') =>
    `<rect x="${x}" y="${y}" width="${w}" height="48" rx="10" fill="${fill}"/><text x="${x + w / 2}" y="${y + 30}" text-anchor="middle" fill="${color}" font-size="18" font-weight="600">${label}</text>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="620" viewBox="0 0 1200 620" role="img" aria-labelledby="title desc">
<title id="title">Faster Compress — ${t.title}</title>
<desc id="desc">${t.subtitle} ${t.note}</desc>
<defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="12" height="12" patternTransform="rotate(30)"><line x1="0" y1="0" x2="0" y2="12" stroke="#F6D7BC" stroke-width="4"/></pattern><marker id="arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7" fill="none" stroke="#0A7A78" stroke-width="1.5"/></marker></defs>
<rect width="1200" height="620" rx="24" fill="#F5FAFC"/>
<g font-family="'Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC', Arial, sans-serif">
<text x="52" y="54" font-family="monospace" font-size="16" font-weight="700" letter-spacing="2" fill="#0A7A78">FASTER COMPRESS / DEEPSEEK HARNESS</text>
<text x="52" y="125" font-size="48" font-weight="800" letter-spacing="-1.5" fill="#153949">${t.title}</text>
<text x="52" y="170" font-size="22" fill="#476777">${t.subtitle}</text>
<path d="M52 207H1148" stroke="#D5E4EA"/>
<text x="52" y="271" font-size="18" font-weight="600" fill="#6A7E88">${t.before}</text>
<path d="M260 268H1124" stroke="#BDCFD8" stroke-width="2"/>
${box(260,244,150,t.request)}${box(426,244,150,t.tool)}
<rect x="592" y="244" width="310" height="48" rx="10" fill="#FBEBDD"/><rect x="592" y="244" width="310" height="48" rx="10" fill="url(#hatch)"/>
<text x="747" y="275" text-anchor="middle" fill="#944B24" font-size="20" font-weight="700">${t.wait}</text>
${box(918,244,190,t.request)}
<text x="52" y="397" font-size="18" font-weight="700" fill="#0A7A78">${t.after}</text>
<path d="M260 394H1124" stroke="#BDCFD8" stroke-width="2"/>
${box(260,370,150,t.request)}${box(426,370,150,t.tool)}${box(592,370,150,t.next)}${box(758,370,150,t.next)}${box(924,370,184,t.next,'#D5EFEB','#096661')}
<path d="M446 424V468H468" fill="none" stroke="#0A7A78" stroke-width="2"/>
${box(468,444,390,t.background,'#D5EFEB','#096661')}
<path d="M858 468H916V424" fill="none" stroke="#0A7A78" stroke-width="2" marker-end="url(#arrow)"/>
<path d="M916 355V421" stroke="#0A7A78" stroke-width="2" stroke-dasharray="4 5"/>
<text x="916" y="342" text-anchor="middle" font-size="16" font-weight="600" fill="#0A7A78">${t.commit}</text>
<path d="M52 530H1148" stroke="#D5E4EA"/>
<text x="52" y="566" font-size="18" fill="#244B5C">${t.footer}</text>
<text x="52" y="596" font-size="14" fill="#6A7E88">${t.note}</text>
</g></svg>\n`
  await writeFile(new URL(`overview-${language}.svg`, target), svg)
}
