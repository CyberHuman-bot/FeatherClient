// Unit tests for the HTML rewriting that keeps users inside the proxy.
const { JSDOM } = require('jsdom');
const { rewriteDocument, unwrapRedirect, buildRequest } = require('../server.js');

let failed = 0;
function check(name, cond) {
    if (cond) { console.log('ok - ' + name); }
    else { console.error('FAIL - ' + name); failed++; }
}

const ORIGIN = 'http://localhost:3000';
const PAGE = 'https://lite.duckduckgo.com/lite/?q=gta';

const dom = new JSDOM(`<body>
<a id="ddg" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.rockstargames.com%2Fgta-v&rut=abc">GTA V</a>
<a id="rel" href="/lite/?q=more">relative</a>
<a id="js" href="javascript:alert(1)">js</a>
<a id="mail" href="mailto:a@b.c">mail</a>
<img id="img" src="/images/logo.png" onerror="alert(1)">
<form id="post" method="post" action="/lite/"><input name="q" value="gta"><input type="submit" value="Next Page &gt;"></form>
<form id="get"><input name="q"></form>
</body>`);
const doc = dom.window.document;
rewriteDocument(doc, PAGE, ORIGIN);
const $ = id => doc.getElementById(id);

check('DDG redirect link unwrapped to real destination',
    $('ddg').getAttribute('data-fn-url') === 'https://www.rockstargames.com/gta-v');
check('link href points back at the proxy',
    $('ddg').getAttribute('href') === ORIGIN + '/render?url=' + encodeURIComponent('https://www.rockstargames.com/gta-v'));
check('relative link resolved then proxied',
    $('rel').getAttribute('data-fn-url') === 'https://lite.duckduckgo.com/lite/?q=more');
check('javascript: href removed', !$('js').hasAttribute('href'));
check('mailto link left alone', $('mail').getAttribute('href') === 'mailto:a@b.c');
check('image src made absolute', $('img').getAttribute('src') === 'https://lite.duckduckgo.com/images/logo.png');
check('inline event handler stripped', !$('img').hasAttribute('onerror'));

const post = $('post');
const hidden = n => post.querySelector(`input[name="${n}"]`).value;
check('POST form now submits GET to /render', post.getAttribute('method') === 'get' && post.getAttribute('action') === ORIGIN + '/render');
check('POST form keeps original action + method',
    hidden('__fn_action') === 'https://lite.duckduckgo.com/lite/' && hidden('__fn_method') === 'post');
check('form with no action falls back to page URL',
    $('get').querySelector('input[name="__fn_action"]').value === PAGE);

// buildRequest: rewritten form submissions
const r1 = buildRequest({ __fn_action: 'https://lite.duckduckgo.com/lite/', __fn_method: 'post', q: 'gta', s: '30' });
check('POST form rebuilds as POST with body', r1.method === 'post' && r1.body === 'q=gta&s=30');
const r2 = buildRequest({ __fn_action: 'https://example.com/s', __fn_method: 'get', q: 'a b' });
check('GET form rebuilds query string', r2.method === 'get' && r2.targetUrl === 'https://example.com/s?q=a+b');
check('plain search term goes to DDG Lite', buildRequest({ q: 'hello world' }).targetUrl === 'https://lite.duckduckgo.com/lite/?q=hello%20world');
check('no params returns null', buildRequest({}) === null);
check('unwrapRedirect leaves normal links alone', unwrapRedirect('https://example.com/a') === 'https://example.com/a');

process.exit(failed ? 1 : 0);
