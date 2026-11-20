// Sample inputs for the "Try a sample" button and for the tests.

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<orders xmlns:pay="https://example.com/payment">
  <order id="1001" date="2026-11-02">
    <customer>
      <name>Anna Schmidt</name>
      <city>Köln</city>
    </customer>
    <item sku="A-17" qty="2">Notebook</item>
    <item sku="B-03" qty="1">Fountain pen</item>
    <total currency="EUR">24.90</total>
    <pay:method>card</pay:method>
    <note><![CDATA[Leave at the door & ring twice]]></note>
  </order>
  <order id="1002" date="2026-11-05">
    <customer>
      <name>Олена Коваль</name>
      <city>Київ</city>
    </customer>
    <item sku="C-88" qty="3">Pencil</item>
    <total currency="EUR">7.50</total>
    <pay:method>invoice</pay:method>
    <note/>
  </order>
</orders>
`;

const XML_BROKEN = `<?xml version="1.0" encoding="UTF-8"?>
<orders>
  <order id="1001">
    <customer>Smith & Sons</customer>
    <total currency="EUR">24.90</total>
  </order>
</orders>
`;

const JSON_SAMPLE = `{
  "store": "Demo shop",
  "orders": [
    {
      "id": 1001,
      "date": "2026-11-02",
      "customer": { "name": "Anna Schmidt", "city": "Köln" },
      "items": [
        { "sku": "A-17", "qty": 2 },
        { "sku": "B-03", "qty": 1 }
      ],
      "total": 24.9,
      "paid": true,
      "note": "Leave at the door, ring twice"
    },
    {
      "id": 1002,
      "date": "2026-11-05",
      "customer": { "name": "Олена Коваль", "city": "Київ" },
      "items": [
        { "sku": "C-88", "qty": 3 }
      ],
      "total": 7.5,
      "paid": false,
      "note": null
    }
  ]
}
`;

const CSV_COMMA = `id,name,city,amount,date,note
1001,Anna Schmidt,Köln,24.90,2026-11-02,"Leave at the door, ring twice"
1002,Олена Коваль,Київ,7.50,2026-11-05,
1003,"O'Brien, Liam",Dublin,120.00,2026-11-09,"Two lines:
second line"
`;

const CSV_SEMICOLON = `id;name;city;amount;date;note
1001;Anna Schmidt;Köln;24,90;2026-11-02;"Leave at the door; ring twice"
1002;Олена Коваль;Київ;7,50;2026-11-05;
1003;"O'Brien, Liam";Dublin;120,00;2026-11-09;"Two lines:
second line"
`;

// A workbook as data; the worker writes it to .xlsx bytes with SheetJS.
export const SHEET_SAMPLE = {
  Orders: [
    ['id', 'name', 'zip', 'amount', 'date', 'paid'],
    [1001, 'Anna Schmidt', '50667', 24.9, { date: '2026-11-02' }, true],
    [1002, 'Олена Коваль', '01001', 7.5, { date: '2026-11-05' }, false],
    [1003, "O'Brien, Liam", 'D02', 120, { date: '2026-11-09' }, true],
  ],
  Notes: [
    ['note'],
    ['A second sheet: choose it in the list above the result.'],
  ],
};

export function sampleText(kind, lang) {
  if (kind === 'xml') return XML;
  if (kind === 'xml-broken') return XML_BROKEN;
  if (kind === 'json') return JSON_SAMPLE;
  if (kind === 'csv') return lang === 'en' ? CSV_COMMA : CSV_SEMICOLON;
  return '';
}
