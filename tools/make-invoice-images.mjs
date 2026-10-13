/**
 * Рисует пакет тестовых накладных для вкладки «Тестирование → Накладные»: apps/web/public/test-invoices/*.jpg.
 * Нужен playwright-core и установленный Chromium, в зависимости проекта они не входят.
 *
 *   PLAYWRIGHT_DIR=/путь/к/папке/с/playwright-core CHROME_PATH=/путь/к/chrome node tools/make-invoice-images.mjs
 *
 * Названия товаров взяты из демо-номенклатуры, поставщики и их ИНН из демо-данных, так что после `npm run seed`
 * накладные сопоставляются с продуктами и поставщиками.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'apps/web/public/test-invoices');
mkdirSync(out, { recursive: true });
const { chromium } = createRequire(resolve(process.env.PLAYWRIGHT_DIR ?? root, 'package.json'))('playwright-core');

const BUYER = 'ООО «Ресторанная группа «Набережная», ИНН 6165123456';

const invoices = [
  {
    file: '01-donskoy-torg12.jpg',
    look: 'scan',
    title: 'ТОВАРНАЯ НАКЛАДНАЯ (форма ТОРГ-12)',
    number: 'ДН-4521',
    date: '13.10.2026',
    supplier: 'Молочный комбинат «Донской»',
    inn: '6163012349',
    priceHead: 'Цена без НДС, руб.',
    vat: 10,
    lines: [
      ['Молоко 3,2% пастеризованное', 'л', 120, 61.5, '20.10.2026'],
      ['Кефир 2,5%', 'л', 80, 57.8, '23.10.2026'],
      ['Сметана 20%', 'кг', 25, 205, '27.10.2026'],
      ['Творог 5%', 'кг', 18, 282, '23.10.2026'],
      ['Сливки 10%', 'л', 30, 185, '27.10.2026'],
    ],
  },
  {
    file: '02-azovskiy-upd.jpg',
    look: 'scan',
    title: 'УНИВЕРСАЛЬНЫЙ ПЕРЕДАТОЧНЫЙ ДОКУМЕНТ',
    number: 'АЗ-0917',
    date: '13.10.2026',
    supplier: 'Мясокомбинат «Азовский»',
    inn: '6161034562',
    priceHead: 'Цена с НДС, руб.',
    priceWithVat: true,
    vat: 10,
    lines: [
      ['Филе грудки цыплёнка-бройлера охл.', 'кг', 35.5, 335, '17.10.2026'],
      ['Говядина (лопаточная часть) охлаждённая', 'кг', 42, 612, '18.10.2026'],
      ['Колбаса Докторская вареная в/у', 'кг', 20, 352, '02.11.2026'],
    ],
  },
  {
    file: '03-hleb4-foto.jpg',
    look: 'photo',
    title: 'РАСХОДНАЯ НАКЛАДНАЯ',
    number: '77/10',
    date: '13.10.2026',
    supplier: 'Хлебозавод №4',
    inn: '6165056782',
    priceHead: 'Цена без НДС, руб.',
    vat: 10,
    lines: [
      ['Хлеб пшеничный формовой', 'шт', 150, 31, '15.10.2026'],
      ['Батон нарезной', 'шт', 120, 24.5, '15.10.2026'],
      ['Булочка с маком', 'шт', 90, 18, '15.10.2026'],
    ],
  },
  {
    file: '04-zernovaya-neizvestnyy-tovar.jpg',
    look: 'stamp',
    title: 'ТОВАРНАЯ НАКЛАДНАЯ (форма ТОРГ-12)',
    number: 'З-2210',
    date: '13.10.2026',
    supplier: 'Агрофирма «Зерновая»',
    inn: '6163023453',
    priceHead: 'Цена без НДС, руб.',
    vat: 10,
    lines: [
      ['Мука пшеничная высший сорт', 'кг', 200, 38.5, ''],
      ['Сахар-песок', 'кг', 100, 54, ''],
      ['Крупа гречневая', 'кг', 80, 92, ''],
      ['Кетчуп томатный «Классический» 1 кг', 'шт', 24, 118, '13.04.2027'],
    ],
  },
  {
    file: '05-svezhiy-urozhay-nechetkoe-foto.jpg',
    look: 'rough',
    title: 'НАКЛАДНАЯ',
    number: '1184',
    date: '13.10.2026',
    supplier: 'ТД «Свежий урожай»',
    inn: '6164045675',
    priceHead: 'Цена без НДС, руб.',
    vat: 10,
    lines: [
      ['Помидоры грунтовые', 'кг', 40, 118, '20.10.2026'],
      ['Огурцы гладкие', 'кг', 30, 96, '20.10.2026'],
      ['Картофель мытый', 'кг', 150, 29, '10.11.2026'],
      ['Лук репчатый', 'кг', 60, 24, '10.11.2026'],
      ['Морковь', 'кг', 50, 27, '10.11.2026'],
      ['Зелень (укроп, петрушка)', 'кг', 5, 410, '16.10.2026'],
    ],
  },
];

const money = (n) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function page(inv) {
  let sum = 0;
  const rows = inv.lines
    .map(([name, unit, qty, price, expires], i) => {
      const net = inv.priceWithVat ? (qty * price) / (1 + inv.vat / 100) : qty * price;
      const total = inv.priceWithVat ? qty * price : net * (1 + inv.vat / 100);
      sum += total;
      return `<tr><td class="c">${i + 1}</td><td>${name}</td><td class="c">${unit}</td><td class="r">${String(qty).replace('.', ',')}</td><td class="r">${money(price)}</td><td class="c">${inv.vat}%</td><td class="r">${money(total)}</td><td class="c">${expires}</td></tr>`;
    })
    .join('');
  const stamp =
    inv.look === 'stamp'
      ? `<svg class="stamp" viewBox="0 0 200 200" width="170" height="170"><circle cx="100" cy="100" r="92" fill="none" stroke="#2d4fb5" stroke-width="4"/><circle cx="100" cy="100" r="66" fill="none" stroke="#2d4fb5" stroke-width="2"/><text x="100" y="92" text-anchor="middle" font-size="19" fill="#2d4fb5" font-family="Liberation Sans" font-weight="700">АГРОФИРМА</text><text x="100" y="116" text-anchor="middle" font-size="19" fill="#2d4fb5" font-family="Liberation Sans" font-weight="700">«ЗЕРНОВАЯ»</text></svg>`
      : '';
  const photo = inv.look === 'photo' || inv.look === 'rough';
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}
body{margin:0;width:1400px;height:1000px;display:flex;align-items:center;justify-content:center;overflow:hidden;
 background:${photo ? 'radial-gradient(circle at 30% 20%,#7a5c3e,#4a3623 70%)' : '#d9dde3'};font-family:"Liberation Serif","DejaVu Serif",serif;color:#161616}
.sheet{position:relative;width:${photo ? 1100 : 1240}px;padding:46px 54px 40px;background:${inv.look === 'rough' ? '#f1ead4' : '#fdfdfb'};
 box-shadow:${photo ? '0 30px 60px rgba(0,0,0,.55)' : '0 6px 18px rgba(0,0,0,.18)'};
 transform:${inv.look === 'photo' ? 'rotate(-2.4deg)' : inv.look === 'rough' ? 'rotate(3.6deg)' : 'none'};
 ${inv.look === 'rough' ? 'filter:blur(.9px) contrast(.88) brightness(.97);' : ''}}
h1{font-size:26px;margin:0 0 4px;text-align:center;letter-spacing:.5px}
.sub{text-align:center;font-size:19px;margin-bottom:22px}
.meta{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:18px;margin-bottom:20px}
.meta b{font-weight:700}
table{width:100%;border-collapse:collapse;font-size:17px}
th,td{border:1.5px solid #222;padding:7px 8px}
th{font-size:15px;font-weight:700;background:#f0f0ec;text-align:center}
td.c{text-align:center}td.r{text-align:right;white-space:nowrap}
.tot{margin-top:14px;text-align:right;font-size:20px}
.sign{margin-top:34px;display:flex;justify-content:space-between;font-size:17px}
.sign span{display:inline-block;min-width:220px;border-bottom:1.5px solid #222;margin-left:8px}
.stamp{position:absolute;right:120px;bottom:30px;opacity:.78;transform:rotate(-12deg)}
.noise{position:fixed;inset:0;opacity:${photo ? 0.22 : 0.05};mix-blend-mode:multiply;pointer-events:none}
</style>
<div class="sheet">
<h1>${inv.title}</h1><div class="sub">№ ${inv.number} от ${inv.date}</div>
<div class="meta"><b>Поставщик:</b><span>${inv.supplier}, ИНН ${inv.inn}</span><b>Покупатель:</b><span>${BUYER}</span><b>Основание:</b><span>Договор поставки № 12 от 01.03.2026</span></div>
<table><tr><th>№</th><th style="width:36%">Наименование товара</th><th>Ед. изм.</th><th>Кол-во</th><th>${inv.priceHead}</th><th>НДС</th><th>Сумма с НДС, руб.</th><th>Срок годности</th></tr>${rows}</table>
<div class="tot">Всего к оплате: <b>${money(sum)} руб.</b></div>
<div class="sign"><div>Отпустил<span></span></div><div>Принял<span></span></div></div>
${stamp}
</div>
<svg class="noise" width="1400" height="1000"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="1400" height="1000" filter="url(#n)"/></svg>`;
}

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] });
const tab = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
for (const inv of invoices) {
  await tab.setContent(page(inv));
  await tab.waitForTimeout(150);
  await tab.screenshot({ path: resolve(out, inv.file), type: 'jpeg', quality: 80 });
  console.log(inv.file);
}
await browser.close();
