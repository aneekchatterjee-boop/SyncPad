// A small, dependency-free syntax highlighter. It works line by line and
// carries state (open block comments, multi-line strings, fenced code) from
// one line to the next. Output is HTML with every piece of text escaped.

const escapeMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
export const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => escapeMap[c]);
const attrMap = { ...escapeMap, '"': '&quot;', "'": '&#39;' };
export const escapeAttr = (s) => String(s).replace(/[&<>"']/g, (c) => attrMap[c]);

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const LANGS = {
  javascript: {
    keywords: words(`break case catch class const continue debugger default delete do else export extends finally for from function
      if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await
      interface type enum implements private public protected readonly as declare namespace abstract keyof satisfies`),
    literals: words('true false null undefined NaN Infinity'),
    line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], multiline: ['`'],
  },
  python: {
    keywords: words(`and as assert async await break class continue def del elif else except finally for from global if import
      in is lambda nonlocal not or pass raise return try while with yield match case self print`),
    literals: words('True False None'),
    line: '#', quotes: ['"', "'"], triple: true,
  },
  clike: {
    keywords: words(`auto break case char const continue default do double else enum extern float for goto if inline int long
      register return short signed sizeof static struct switch typedef union unsigned void volatile while class public private
      protected virtual template typename namespace using new delete this throw try catch bool final override abstract extends
      implements import package interface boolean byte String std include define`),
    literals: words('true false null nullptr NULL'),
    line: '//', block: ['/*', '*/'], quotes: ['"', "'"],
  },
  go: {
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map package
      range return select struct switch type var string int int64 float64 bool byte rune error make len append`),
    literals: words('true false nil iota'),
    line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], multiline: ['`'],
  },
  rust: {
    keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut
      pub ref return self Self static struct super trait type unsafe use where while i32 i64 u8 u32 u64 usize f32 f64 bool str String Vec Option Result`),
    literals: words('true false None Some Ok Err'),
    line: '//', block: ['/*', '*/'], quotes: ['"'],
  },
  sql: {
    keywords: words(`select from where and or not insert into values update set delete create table drop alter add index primary key
      foreign references join left right inner outer full on group by order having limit offset as distinct union all case when
      then else end in is like between exists count sum avg min max default constraint unique varchar integer int text boolean`),
    literals: words('true false null'),
    line: '--', block: ['/*', '*/'], quotes: ["'", '"'], caseInsensitive: true,
  },
  json: {
    keywords: new Set(),
    literals: words('true false null'),
    quotes: ['"'],
  },
};

const NUMBER = /^(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)/i;
const IDENT = /^[A-Za-z_$][\w$]*/;

const span = (cls, text) => `<span class="t-${cls}">${escapeHtml(text)}</span>`;

function highlightCode(lines, lang) {
  const out = new Array(lines.length);
  let state = null; // { kind: 'block' } | { kind: 'string', quote }

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    let html = '';
    let i = 0;

    if (state?.kind === 'block') {
      const end = line.indexOf(lang.block[1]);
      if (end === -1) { out[n] = span('com', line); continue; }
      html += span('com', line.slice(0, end + lang.block[1].length));
      i = end + lang.block[1].length;
      state = null;
    } else if (state?.kind === 'string') {
      const end = findClosing(line, 0, state.quote);
      if (end === -1) { out[n] = span('str', line); continue; }
      html += span('str', line.slice(0, end));
      i = end;
      state = null;
    }

    while (i < line.length) {
      const rest = line.slice(i);
      const ch = line[i];

      if (lang.line && rest.startsWith(lang.line)) { html += span('com', rest); break; }
      if (lang.block && rest.startsWith(lang.block[0])) {
        const end = line.indexOf(lang.block[1], i + lang.block[0].length);
        if (end === -1) { html += span('com', rest); state = { kind: 'block' }; break; }
        html += span('com', line.slice(i, end + lang.block[1].length));
        i = end + lang.block[1].length;
        continue;
      }
      if (lang.quotes?.includes(ch)) {
        const quote = lang.triple && rest.startsWith(ch.repeat(3)) ? ch.repeat(3) : ch;
        const end = findClosing(line, i + quote.length, quote);
        if (end === -1) {
          html += span('str', rest);
          if (quote.length === 3 || lang.multiline?.includes(ch)) state = { kind: 'string', quote };
          break;
        }
        html += span('str', line.slice(i, end));
        i = end;
        continue;
      }
      const num = /[\d]/.test(ch) && (i === 0 || !/[\w$]/.test(line[i - 1])) ? rest.match(NUMBER) : null;
      if (num) { html += span('num', num[0]); i += num[0].length; continue; }
      const ident = rest.match(IDENT);
      if (ident) {
        const word = ident[0];
        const key = lang.caseInsensitive ? word.toLowerCase() : word;
        if (lang.keywords.has(key)) html += span('kw', word);
        else if (lang.literals.has(key)) html += span('lit', word);
        else if (line[i + word.length] === '(') html += span('fn', word);
        else html += escapeHtml(word);
        i += word.length;
        continue;
      }
      if (/[{}()[\];,.:=+\-*/<>!&|?%^~]/.test(ch)) { html += span('op', ch); i++; continue; }
      html += escapeHtml(ch);
      i++;
    }
    out[n] = html;
  }
  return out;
}

// Index just past the closing quote, or -1 if the string runs off the line.
function findClosing(line, from, quote) {
  for (let i = from; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line.startsWith(quote, i)) return i + quote.length;
  }
  return -1;
}

function inlineMarkdown(text) {
  let html = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) { html += span('md-code', text.slice(i, end + 1)); i = end + 1; continue; }
    }
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) { html += span('md-bold', text.slice(i, end + 2)); i = end + 2; continue; }
    }
    if (text[i] === '[') {
      const m = text.slice(i).match(/^\[[^\]]*\]\([^)]*\)/);
      if (m) { html += span('md-link', m[0]); i += m[0].length; continue; }
    }
    html += escapeHtml(text[i]);
    i++;
  }
  return html;
}

function highlightMarkdown(lines) {
  let fenced = false;
  return lines.map((line) => {
    if (/^\s*```/.test(line)) { fenced = !fenced; return span('md-fence', line); }
    if (fenced) return span('md-code', line);
    if (/^#{1,6}\s/.test(line)) return span('md-h', line);
    if (/^\s*>/.test(line)) return span('md-quote', line);
    const list = line.match(/^(\s*)([-*+]|\d+\.)(\s+)(\[[ xX]\]\s)?/);
    if (list) {
      return escapeHtml(list[1]) + span('md-list', list[2]) + list[3] + (list[4] ? span('md-task', list[4]) : '') + inlineMarkdown(line.slice(list[0].length));
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) return span('md-rule', line);
    return inlineMarkdown(line);
  });
}

// Returns one HTML string per line.
export function highlightLines(lines, langId) {
  if (langId === 'markdown') return highlightMarkdown(lines);
  const lang = LANGS[langId];
  if (!lang) return lines.map(escapeHtml);
  return highlightCode(lines, lang);
}
