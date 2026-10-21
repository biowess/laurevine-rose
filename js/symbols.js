/* symbols.js — curated symbol catalog + search (pure data/logic, no DOM; loads in Node for tests).
   Entry format: 'char|name|keywords'. Categories are curated for researchers, NOT "all of Unicode".
   API: RPE.symbols = { CATEGORIES, all(), get(id), search(query, categoryId?), find(char), codePoint(ch), label(sym), validate() }
   Rules (enforced by validate()): every symbol has a name; no duplicate char inside one category; real, printable code points
   (no controls / lone surrogates / private use / U+FFFD); one code point per symbol. Canonical-equivalent pairs (U+03A9 vs U+2126 ohm,
   U+00C5 vs U+212B angstrom) are avoided on purpose: Unicode normalisation would silently turn one into the other. */
(function (RPE) {
  'use strict';

  const DEFS = [
    ['greek', 'Greek letters', 'α', [
      'α|alpha|angle alpha', 'β|beta|beta', 'γ|gamma|gamma', 'δ|delta|small delta change', 'ε|epsilon|epsilon small', 'ζ|zeta|zeta', 'η|eta|efficiency viscosity',
      'θ|theta|angle theta', 'ι|iota|iota', 'κ|kappa|curvature kappa', 'λ|lambda|wavelength eigenvalue', 'μ|mu|micro mean', 'ν|nu|frequency nu', 'ξ|xi|xi',
      'ο|omicron|omicron', 'π|pi|pi circle', 'ρ|rho|density correlation', 'σ|sigma|standard deviation sigma', 'ς|final sigma|sigma final', 'τ|tau|time constant tau',
      'υ|upsilon|upsilon', 'φ|phi|phi golden', 'χ|chi|chi square', 'ψ|psi|psi wave function', 'ω|omega|angular frequency omega',
      'ϑ|theta symbol|theta variant', 'ϕ|phi symbol|phi variant', 'ϖ|pi symbol|pi variant', 'ϱ|rho symbol|rho variant', 'ϵ|lunate epsilon|epsilon variant',
      'Α|Alpha|capital alpha', 'Β|Beta|capital beta', 'Γ|Gamma|capital gamma', 'Δ|Delta|capital delta change difference', 'Ε|Epsilon|capital epsilon', 'Ζ|Zeta|capital zeta',
      'Η|Eta|capital eta', 'Θ|Theta|capital theta', 'Ι|Iota|capital iota', 'Κ|Kappa|capital kappa', 'Λ|Lambda|capital lambda', 'Μ|Mu|capital mu', 'Ν|Nu|capital nu',
      'Ξ|Xi|capital xi', 'Ο|Omicron|capital omicron', 'Π|Pi|capital pi product', 'Ρ|Rho|capital rho', 'Σ|Sigma|capital sigma sum', 'Τ|Tau|capital tau', 'Υ|Upsilon|capital upsilon',
      'Φ|Phi|capital phi', 'Χ|Chi|capital chi', 'Ψ|Psi|capital psi', 'Ω|Omega|capital omega ohm']],
    ['operators', 'Math operators', '±', [
      '+|plus|add addition', '−|minus|subtract subtraction', '±|plus-minus|plus minus tolerance', '∓|minus-plus|minus plus', '×|multiplication|times multiply cross',
      '÷|division|divide', '⋅|dot operator|multiply dot', '∗|asterisk operator|convolution star', '∘|ring operator|composition compose', '∙|bullet operator|bullet',
      '⊕|circled plus|direct sum xor', '⊖|circled minus|circled minus', '⊗|circled times|tensor product kronecker', '⊘|circled division slash|circled slash', '⊙|circled dot|circled dot hadamard',
      '∑|summation|sum sigma n-ary', '∏|product|product pi n-ary', '∐|coproduct|coproduct', '√|square root|root radical', '∛|cube root|root radical cube', '∜|fourth root|root radical',
      '∣|divides|divides bar', '∤|does not divide|not divides', '∥|parallel to|parallel', '∦|not parallel|not parallel', '⊥|perpendicular|perpendicular orthogonal',
      '∠|angle|angle', '∡|measured angle|measured angle', '∕|division slash|slash fraction', '⁄|fraction slash|fraction slash', '⌈|left ceiling|ceiling', '⌉|right ceiling|ceiling',
      '⌊|left floor|floor', '⌋|right floor|floor']],
    ['relations', 'Relations & comparison', '≤', [
      '=|equals|equal', '≠|not equal|inequality unequal', '≈|approximately equal|approx almost', '≃|asymptotically equal|similar equal', '≅|congruent|congruent isomorphic',
      '≡|identical to|equivalent identical congruence', '≢|not identical|not equivalent', '∼|tilde operator|similar distributed as', '≁|not similar|not similar', '≍|equivalent to|equivalent',
      '≐|approaches the limit|approaches limit', '<|less than|less smaller', '>|greater than|greater larger', '≤|less than or equal|leq at most', '≥|greater than or equal|geq at least',
      '≦|less than over equal|leqq', '≧|greater than over equal|geqq', '≪|much less than|much smaller', '≫|much greater than|much larger', '≮|not less than|not less',
      '≯|not greater than|not greater', '≰|neither less nor equal|not leq', '≱|neither greater nor equal|not geq', '≲|less than or equivalent|less similar', '≳|greater than or equivalent|greater similar',
      '∝|proportional to|proportional varies', '≜|delta equal to|defined as', '≔|colon equals|assignment define', '≕|equals colon|assignment define', '≺|precedes|precedes order',
      '≻|succeeds|succeeds order', '≼|precedes or equal|precedes order', '≽|succeeds or equal|succeeds order', '⊢|right tack|proves entails turnstile', '⊣|left tack|left turnstile']],
    ['calculus', 'Calculus & advanced math', '∫', [
      '∫|integral|integral', '∬|double integral|double integral surface', '∭|triple integral|triple integral volume', '∮|contour integral|contour closed integral', '∯|surface integral|closed surface integral',
      '∰|volume integral|closed volume integral', '∂|partial differential|partial derivative', '∇|nabla|del gradient divergence curl', '∆|increment|laplacian delta change', '∑|summation|sum series',
      '∏|product|product series', '∞|infinity|infinite', '′|prime|derivative minutes feet', '″|double prime|second derivative seconds inches', '‴|triple prime|third derivative',
      '√|square root|root radical', 'ℏ|h-bar|reduced planck constant', 'ℓ|script l|liter length ell', 'ℜ|real part|real part', 'ℑ|imaginary part|imaginary part',
      '℘|Weierstrass p|weierstrass elliptic', 'ℵ|aleph|aleph cardinality', 'ℶ|beth|beth cardinality', '⟨|left angle bracket|bra inner product', '⟩|right angle bracket|ket inner product',
      '‖|double vertical line|norm', '∥|parallel bars|norm parallel', '⌈|left ceiling|ceiling', '⌉|right ceiling|ceiling', '⌊|left floor|floor', '⌋|right floor|floor',
      '⊗|tensor product|tensor kronecker', '⊕|direct sum|direct sum', '∘|composition|compose function', '∝|proportional to|proportional', '∴|therefore|therefore', '∵|because|because',
      '⋯|midline ellipsis|dots cdots', '⋮|vertical ellipsis|vdots dots', '⋱|diagonal ellipsis|ddots dots']],
    ['sets', 'Set theory & logic', '∈', [
      '∈|element of|in member', '∉|not an element of|not in', '∋|contains as member|owns', '∌|does not contain|not contains', '∅|empty set|null set',
      '⊂|subset of|subset', '⊃|superset of|superset', '⊄|not a subset of|not subset', '⊅|not a superset of|not superset', '⊆|subset or equal|subset equal',
      '⊇|superset or equal|superset equal', '⊈|not subset or equal|not subset', '⊉|not superset or equal|not superset', '⊊|proper subset|strict subset', '⊋|proper superset|strict superset',
      '∪|union|union', '∩|intersection|intersection', '∖|set minus|difference complement', '⊎|multiset union|multiset union', 'ℂ|complex numbers|double-struck C complex',
      'ℍ|quaternions|double-struck H quaternion', 'ℕ|natural numbers|double-struck N natural', 'ℙ|primes|double-struck P prime probability', 'ℚ|rational numbers|double-struck Q rational',
      'ℝ|real numbers|double-struck R real', 'ℤ|integers|double-struck Z integer', '∀|for all|universal quantifier', '∃|there exists|existential quantifier', '∄|there does not exist|not exists',
      '¬|not|negation logical not', '∧|logical and|and conjunction wedge', '∨|logical or|or disjunction vee', '⊻|xor|exclusive or', '⊼|nand|nand', '⊤|down tack|true top tautology',
      '⊥|up tack|false bottom contradiction', '⊨|models|true entails semantic', '⊩|forces|forces', '⇒|implies|implies rightwards double arrow', '⇐|implied by|implied by',
      '⇔|if and only if|iff equivalent biconditional', '∴|therefore|therefore', '∵|because|because', '∎|end of proof|qed halmos tombstone']],
    ['arrows', 'Arrows', '→', [
      '←|leftwards arrow|left', '↑|upwards arrow|up increase', '→|rightwards arrow|right', '↓|downwards arrow|down decrease', '↔|left right arrow|both bidirectional',
      '↕|up down arrow|both vertical', '↖|north west arrow|diagonal', '↗|north east arrow|diagonal increase', '↘|south east arrow|diagonal decrease', '↙|south west arrow|diagonal',
      '⇐|leftwards double arrow|implied by', '⇑|upwards double arrow|double up', '⇒|rightwards double arrow|implies', '⇓|downwards double arrow|double down', '⇔|left right double arrow|iff equivalent',
      '⇕|up down double arrow|double vertical', '↦|rightwards arrow from bar|maps to', '↤|leftwards arrow from bar|maps from', '↪|rightwards arrow with hook|inclusion embedding', '↩|leftwards arrow with hook|return',
      '↠|rightwards two headed arrow|surjection', '↣|rightwards arrow with tail|injection', '⟵|long leftwards arrow|long left', '⟶|long rightwards arrow|long right', '⟷|long left right arrow|long both',
      '⟸|long leftwards double arrow|long implied by', '⟹|long rightwards double arrow|long implies', '⟺|long left right double arrow|long iff', '⟼|long rightwards arrow from bar|long maps to',
      '⇌|rightwards harpoon over leftwards|equilibrium reversible reaction', '⇋|leftwards harpoon over rightwards|equilibrium reversible reaction', '⇄|rightwards arrow over leftwards|exchange', '⇆|leftwards arrow over rightwards|exchange',
      '⇀|rightwards harpoon|vector harpoon', '↼|leftwards harpoon|vector harpoon', '↺|anticlockwise open circle arrow|rotate counterclockwise', '↻|clockwise open circle arrow|rotate clockwise refresh',
      '↶|anticlockwise top semicircle arrow|undo', '↷|clockwise top semicircle arrow|redo', '↝|rightwards wave arrow|wave', '⇝|rightwards squiggle arrow|squiggle']],
    ['scripts', 'Superscripts & subscripts', 'x²', [
      '⁰|superscript zero|power exponent 0', '¹|superscript one|power exponent 1', '²|superscript two|squared power exponent 2', '³|superscript three|cubed power exponent 3', '⁴|superscript four|power exponent 4',
      '⁵|superscript five|power exponent 5', '⁶|superscript six|power exponent 6', '⁷|superscript seven|power exponent 7', '⁸|superscript eight|power exponent 8', '⁹|superscript nine|power exponent 9',
      '⁺|superscript plus|charge ion plus', '⁻|superscript minus|charge ion minus inverse', '⁼|superscript equals|equals', '⁽|superscript left parenthesis|parenthesis', '⁾|superscript right parenthesis|parenthesis',
      'ⁿ|superscript n|power n exponent', 'ⁱ|superscript i|index i', '₀|subscript zero|index 0', '₁|subscript one|index 1', '₂|subscript two|index 2 water h2o',
      '₃|subscript three|index 3', '₄|subscript four|index 4', '₅|subscript five|index 5', '₆|subscript six|index 6', '₇|subscript seven|index 7', '₈|subscript eight|index 8', '₉|subscript nine|index 9',
      '₊|subscript plus|plus', '₋|subscript minus|minus', '₌|subscript equals|equals', '₍|subscript left parenthesis|parenthesis', '₎|subscript right parenthesis|parenthesis',
      'ₐ|subscript a|index a', 'ₑ|subscript e|index e', 'ₒ|subscript o|index o', 'ₓ|subscript x|index x', 'ₙ|subscript n|index n', 'ₘ|subscript m|index m']],
    ['units', 'Units, technical & scientific', 'Å', [
      '°|degree sign|degree angle temperature', '℃|degree celsius|celsius temperature', '℉|degree fahrenheit|fahrenheit temperature', 'µ|micro sign|micro prefix unit', 'Å|angstrom|angstrom length unit',
      '‰|per mille|permille per thousand', '‱|per ten thousand|basis point permyriad', 'ℓ|litre|liter volume unit', '℮|estimated sign|estimated e', '№|numero sign|number numero',
      '⌀|diameter sign|diameter', '∠|angle|angle', '⊥|perpendicular|perpendicular', '±|plus-minus|tolerance error', '×|multiplication sign|times scientific notation',
      '·|middle dot|dot product unit separator', '′|prime|minutes arcminutes feet', '″|double prime|seconds arcseconds inches', '♀|female sign|female venus', '♂|male sign|male mars',
      '⚠|warning sign|warning hazard caution', '☢|radioactive sign|radiation hazard', '☣|biohazard sign|biohazard hazard', '✓|check mark|tick yes done', '✗|ballot x|cross no wrong',
      '☐|ballot box|checkbox empty', '☑|ballot box with check|checkbox checked', '☒|ballot box with x|checkbox cross', '⏚|earth ground|ground earth electrical', '⎓|direct current|dc current electrical',
      '∿|sine wave|sine wave signal', '⏦|ac current|ac electrical']],
    ['typography', 'Typography & special characters', '§', [
      '–|en dash|dash range', '—|em dash|dash', '―|horizontal bar|dash quotation', '‐|hyphen|hyphen', '‑|non-breaking hyphen|hyphen no break', '‒|figure dash|dash figure',
      '…|horizontal ellipsis|ellipsis dots', '‥|two dot leader|leader', '•|bullet|bullet list', '‣|triangular bullet|bullet list', '◦|white bullet|bullet list', '▪|black small square|bullet square',
      '‘|left single quotation mark|quote', '’|right single quotation mark|quote apostrophe', '‚|single low quotation mark|quote', '“|left double quotation mark|quote', '”|right double quotation mark|quote',
      '„|double low quotation mark|quote german', '«|left guillemet|quote french angle', '»|right guillemet|quote french angle', '‹|single left guillemet|quote angle', '›|single right guillemet|quote angle',
      '†|dagger|footnote obelisk', '‡|double dagger|footnote', '§|section sign|section paragraph law', '¶|pilcrow|paragraph', '©|copyright|copyright', '®|registered|registered trademark',
      '™|trade mark|trademark', '℠|service mark|servicemark', '¢|cent|currency', '£|pound|currency sterling', '¥|yen|currency', '€|euro|currency', '₹|rupee|currency india',
      '¿|inverted question mark|spanish question', '¡|inverted exclamation mark|spanish exclamation', '‽|interrobang|question exclamation', '⁂|asterism|asterism', '※|reference mark|reference note',
      '¦|broken bar|bar', '\u00A0|no-break space|nbsp non-breaking space', '\u2009|thin space|thin space', '\u202F|narrow no-break space|nnbsp thin space units']]
  ];

  const WS_LABEL = { '\u00A0': 'NBSP', '\u2009': 'THIN', '\u202F': 'NNBSP' };   // invisible characters get a visible label in the grid

  const CATEGORIES = DEFS.map((d) => ({
    id: d[0], label: d[1], icon: d[2],
    symbols: d[3].map((s) => {
      const p = s.split('|');
      return { c: p[0], n: p[1] || '', k: p[2] || '', cat: d[0] };
    })
  }));

  const get = (id) => CATEGORIES.find((c) => c.id === id) || null;
  const all = () => [].concat(...CATEGORIES.map((c) => c.symbols));
  const codePoint = (ch) => ch.codePointAt(0);
  const hex = (ch) => 'U+' + codePoint(ch).toString(16).toUpperCase().padStart(4, '0');
  const label = (sym) => WS_LABEL[sym.c] || sym.c;
  const find = (ch) => all().find((s) => s.c === ch) || null;

  /* Simple substring search on name / keywords / character (case-insensitive). Empty query -> the category's symbols (or all).
     Ranking: exact char, then name starts-with, then name contains, then keyword/hex contains. Within a rank, catalog order. Duplicate
     characters across categories collapse to the first hit when searching everything. */
  function search(query, categoryId) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    const pool = categoryId ? ((get(categoryId) || { symbols: [] }).symbols) : all();
    if (!q) return pool.slice();
    const out = [], seen = new Set();
    pool.forEach((s, i) => {
      const name = s.n.toLowerCase(), kw = s.k.toLowerCase();
      let rank = -1;
      if (s.c.toLowerCase() === q) rank = 0;
      else if (name.startsWith(q)) rank = 1;
      else if (name.includes(q)) rank = 2;
      else if (kw.includes(q) || hex(s.c).toLowerCase().includes(q) || s.c.toLowerCase().includes(q)) rank = 3;
      if (rank < 0 || (!categoryId && seen.has(s.c))) return;
      seen.add(s.c); out.push({ s, rank, i });
    });
    return out.sort((a, b) => a.rank - b.rank || a.i - b.i).map((x) => x.s);
  }

  /* Catalog integrity report: [] when clean. Used by tests/test_symbols.js and handy in the console. */
  function validate() {
    const bad = [];
    CATEGORIES.forEach((cat) => {
      const seen = new Set();
      cat.symbols.forEach((s) => {
        const where = cat.id + ':' + JSON.stringify(s.c);
        const cps = Array.from(s.c);
        if (cps.length !== 1) { bad.push(where + ' must be exactly one code point'); return; }
        const cp = s.c.codePointAt(0);
        if (!(cp >= 0x20 && cp <= 0x10FFFF) || (cp >= 0x7F && cp <= 0x9F) || (cp >= 0xD800 && cp <= 0xDFFF) || (cp >= 0xE000 && cp <= 0xF8FF) || cp === 0xFFFD || (cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) === 0xFFFE) bad.push(where + ' invalid code point');
        if (s.c.normalize('NFC') !== s.c) bad.push(where + ' changes under NFC (use the canonical form)');
        if (!s.n || !s.n.trim()) bad.push(where + ' has no name');
        if (seen.has(s.c)) bad.push(where + ' duplicate in category'); seen.add(s.c);
      });
      if (!cat.symbols.length) bad.push(cat.id + ' is empty');
    });
    return bad;
  }

  RPE.symbols = { CATEGORIES, WS_LABEL, all, get, search, find, codePoint, hex, label, validate };
})(typeof window !== 'undefined' ? (window.RPE = window.RPE || {}) : (global.RPE = global.RPE || {}));
