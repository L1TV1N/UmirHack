/**
 * Сборка УПД в формате ФНС для проверок и демонстрации: те же теги и атрибуты, что в файлах из 1С и ЭДО.
 * Нужна тестам разбора и команде, которая кладёт образец в docs/samples.
 */
export interface SampleLine {
  name: string;
  code?: string;
  unitCode?: string;
  unitName?: string;
  quantity: string;
  price?: string;
  sumWithoutVat?: string;
  gtin?: string;
  vsd?: string;
  expires?: string;
  kiz?: string[];
  extraInfo?: { id: string; value: string }[];
}

export interface SampleInvoice {
  number: string;
  date: string;
  supplier?: { name: string; inn: string } | { ipInn: string; surname: string; name: string; patronymic: string };
  lines: SampleLine[];
  encoding?: 'windows-1251' | 'UTF-8';
  extraHead?: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildUpdXml(inv: SampleInvoice): string {
  const supplier = !inv.supplier
    ? ''
    : 'inn' in inv.supplier
      ? `<СвПрод><ИдСв><СвЮЛУч НаимОрг="${esc(inv.supplier.name)}" ИННЮЛ="${inv.supplier.inn}" КПП="616301001"/></ИдСв></СвПрод>`
      : `<СвПрод><ИдСв><СвИП ИННФЛ="${inv.supplier.ipInn}"><ФИО Фамилия="${esc(inv.supplier.surname)}" Имя="${esc(inv.supplier.name)}" Отчество="${esc(inv.supplier.patronymic)}"/></СвИП></ИдСв></СвПрод>`;

  const rows = inv.lines
    .map((l, i) => {
      const extra = [
        ...(l.expires ? [{ id: 'Срок_годности', value: l.expires }] : []),
        ...(l.gtin ? [{ id: 'GTIN', value: l.gtin }] : []),
        ...(l.vsd ? [{ id: 'Номер ВСД', value: l.vsd }] : []),
        ...(l.extraInfo ?? []),
      ]
        .map((x) => `<ИнфПолФХЖ2 Идентиф="${esc(x.id)}" Значен="${esc(x.value)}"/>`)
        .join('');
      const kiz = l.kiz?.length ? `<НомСредИдентТов>${l.kiz.map((k) => `<КИЗ>${esc(k)}</КИЗ>`).join('')}</НомСредИдентТов>` : '';
      return (
        `<СведТов НомСтр="${i + 1}" НаимТов="${esc(l.name)}" ОКЕИ_Тов="${l.unitCode ?? '796'}" КолТов="${l.quantity}"` +
        `${l.price ? ` ЦенаТов="${l.price}"` : ''}${l.sumWithoutVat ? ` СтТовБезНДС="${l.sumWithoutVat}"` : ''} НалСт="10%">` +
        `<Акциз><БезАкциз>без акциза</БезАкциз></Акциз>` +
        `<ДопСведТов${l.code ? ` КодТов="${esc(l.code)}"` : ''}${l.unitName ? ` НаимЕдИзм="${esc(l.unitName)}"` : ''}>${kiz}</ДопСведТов>${extra}</СведТов>`
      );
    })
    .join('\n      ');

  return (
    `<?xml version="1.0" encoding="${inv.encoding ?? 'windows-1251'}"?>\n` +
    `<Файл ИдФайл="ON_NSCHFDOPPR_2BM-DEMO_20261009" ВерсФорм="5.03" ВерсПрог="Запас-демо">\n` +
    `  <Документ КНД="1115131" Функция="СЧФДОП" ДатаИнфПр="${inv.date}" ВремИнфПр="09.00.00" НаимЭконСубСост="Демо-поставщик">\n` +
    `    <СвСчФакт НомерСчФ="${esc(inv.number)}" ДатаСчФ="${inv.date}" КодОКВ="643">${supplier}${inv.extraHead ?? ''}</СвСчФакт>\n` +
    `    <ТаблСчФакт>\n      ${rows}\n    </ТаблСчФакт>\n` +
    `  </Документ>\n</Файл>\n`
  );
}

/** Кодирование текста в windows-1251 (Node сам этого не умеет): нужно для образцов, как их отдаёт 1С. */
export function encodeCp1251(text: string): Buffer {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x80) out.push(c);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else if (c === 0xab) out.push(0xab);
    else if (c === 0xbb) out.push(0xbb);
    else if (c === 0x2116) out.push(0xb9);
    else if (c === 0xa0) out.push(0xa0);
    else out.push(0x3f);
  }
  return Buffer.from(out);
}
