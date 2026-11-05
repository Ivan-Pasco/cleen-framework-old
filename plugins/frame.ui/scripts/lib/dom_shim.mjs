/**
 * dom_shim.mjs — a minimal in-memory DOM for running runtime/loader.js under
 * Node.js without a browser or third-party packages.
 *
 * Covers what the loader's startup path and event dispatch touch: elements
 * and text nodes, an innerHTML parser/serializer, attributes / dataset /
 * classList, simple CSS selectors (tag, #id, .class, [attr], [attr=value],
 * descendant and child combinators, selector lists), closest(), events with
 * capture / target / bubble phases, and MutationObserver (childList,
 * attributes, subtree) delivered on the microtask queue.
 *
 * It is a test double: anything outside that surface is deliberately absent
 * so a loader change that starts depending on more of the DOM fails loudly.
 */

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function decodeEntities(text) {
	return text
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
		.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

function escapeText(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text) {
	return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Mutation observers
// ---------------------------------------------------------------------------

const observers = new Set();

function queueMutation(record) {
	for (const obs of observers) obs._consider(record);
}

export class MutationObserver {
	constructor(callback) {
		this._callback = callback;
		this._targets = [];
		this._records = [];
		this._scheduled = false;
	}
	observe(target, options) {
		this._targets.push({ target, options: options || {} });
		observers.add(this);
	}
	disconnect() {
		this._targets = [];
		this._records = [];
		observers.delete(this);
	}
	takeRecords() {
		const r = this._records;
		this._records = [];
		return r;
	}
	_consider(record) {
		for (const { target, options } of this._targets) {
			const inScope = record.target === target || (options.subtree && target.contains(record.target));
			if (!inScope) continue;
			if (record.type === 'childList' && !options.childList) continue;
			if (record.type === 'attributes' && !options.attributes) continue;
			this._records.push(record);
			if (!this._scheduled) {
				this._scheduled = true;
				queueMicrotask(() => {
					this._scheduled = false;
					const records = this.takeRecords();
					if (records.length) this._callback(records, this);
				});
			}
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export class Event {
	constructor(type, init = {}) {
		this.type = type;
		this.bubbles = !!init.bubbles;
		this.cancelable = !!init.cancelable;
		this.defaultPrevented = false;
		this.target = null;
		this.currentTarget = null;
		this.eventPhase = 0;
		this._stop = false;
		this._stopImmediate = false;
		this._inPassive = false;
		for (const k of Object.keys(init)) {
			if (!(k in this)) this[k] = init[k];
		}
	}
	preventDefault() {
		if (this.cancelable && !this._inPassive) this.defaultPrevented = true;
	}
	stopPropagation() { this._stop = true; }
	stopImmediatePropagation() { this._stop = true; this._stopImmediate = true; }
}

export class CustomEvent extends Event {
	constructor(type, init = {}) {
		super(type, init);
		this.detail = init.detail;
	}
}

class EventTargetImpl {
	constructor() { this._listeners = []; }
	addEventListener(type, fn, options) {
		const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
		const once = !!(options && typeof options === 'object' && options.once);
		const passive = !!(options && typeof options === 'object' && options.passive);
		if (this._listeners.some(l => l.type === type && l.fn === fn && l.capture === capture)) return;
		this._listeners.push({ type, fn, capture, once, passive });
	}
	removeEventListener(type, fn, options) {
		const capture = typeof options === 'boolean' ? options : !!(options && options.capture);
		this._listeners = this._listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === capture));
	}
	_invoke(event, phase) {
		for (const l of this._listeners.slice()) {
			if (l.type !== event.type) continue;
			if (phase === 1 && !l.capture) continue;
			if (phase === 3 && l.capture) continue;
			if (l.once) this.removeEventListener(l.type, l.fn, l.capture);
			event.currentTarget = this;
			event._inPassive = l.passive;
			l.fn.call(this, event);
			event._inPassive = false;
			if (event._stopImmediate) return;
		}
	}
	dispatchEvent(event) {
		event.target = this;
		const path = [];
		for (let n = this._parentForEvents(); n; n = n._parentForEvents()) path.push(n);
		for (let i = path.length - 1; i >= 0 && !event._stop; i--) {
			event.eventPhase = 1;
			path[i]._invoke(event, 1);
		}
		if (!event._stop) {
			event.eventPhase = 2;
			this._invoke(event, 2);
		}
		if (event.bubbles) {
			for (let i = 0; i < path.length && !event._stop; i++) {
				event.eventPhase = 3;
				path[i]._invoke(event, 3);
			}
		}
		event.currentTarget = null;
		event.eventPhase = 0;
		return !event.defaultPrevented;
	}
	_parentForEvents() { return null; }
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

function parseCompound(src) {
	const parts = { tag: null, id: null, classes: [], attrs: [] };
	const re = /([a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[\s*([^\s~|^$*=\]]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\s*)?\]/gy;
	let m;
	let pos = 0;
	while (pos < src.length) {
		re.lastIndex = pos;
		m = re.exec(src);
		if (!m) throw new Error('dom_shim: unsupported selector "' + src + '"');
		if (m[1]) parts.tag = m[1] === '*' ? null : m[1].toUpperCase();
		else if (m[2]) parts.id = m[2];
		else if (m[3]) parts.classes.push(m[3]);
		else parts.attrs.push({ name: m[4].toLowerCase(), value: m[5] ?? m[6] ?? m[7] });
		pos = re.lastIndex;
	}
	return parts;
}

function parseSelector(selector) {
	return selector.split(',').map(s => s.trim()).filter(Boolean).map(single => {
		const tokens = single.replace(/\s*>\s*/g, ' > ').split(/\s+/);
		const steps = [];
		let combinator = ' ';
		for (const t of tokens) {
			if (t === '>') { combinator = '>'; continue; }
			steps.push({ combinator, compound: parseCompound(t) });
			combinator = ' ';
		}
		return steps;
	});
}

function matchesCompound(el, c) {
	if (c.tag && el.tagName !== c.tag) return false;
	if (c.id && el.getAttribute('id') !== c.id) return false;
	for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
	for (const a of c.attrs) {
		const v = el.getAttribute(a.name);
		if (v === null) return false;
		if (a.value !== undefined && v !== a.value) return false;
	}
	return true;
}

function matchesSteps(el, steps, i) {
	if (!matchesCompound(el, steps[i].compound)) return false;
	if (i === 0) return true;
	if (steps[i].combinator === '>') {
		const p = el.parentElement;
		return !!p && matchesSteps(p, steps, i - 1);
	}
	for (let p = el.parentElement; p; p = p.parentElement) {
		if (matchesSteps(p, steps, i - 1)) return true;
	}
	return false;
}

function matchesSelector(el, selector) {
	return parseSelector(selector).some(steps => matchesSteps(el, steps, steps.length - 1));
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

class NodeImpl extends EventTargetImpl {
	constructor(nodeType, ownerDocument) {
		super();
		this.nodeType = nodeType;
		this.ownerDocument = ownerDocument;
		this.parentNode = null;
		this.childNodes = [];
	}
	get parentElement() {
		return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
	}
	get firstChild() { return this.childNodes[0] || null; }
	get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
	get nextSibling() {
		if (!this.parentNode) return null;
		const sib = this.parentNode.childNodes;
		return sib[sib.indexOf(this) + 1] || null;
	}
	get children() { return this.childNodes.filter(n => n.nodeType === 1); }
	_parentForEvents() {
		if (this.parentNode) return this.parentNode;
		return null;
	}
	contains(node) {
		for (let n = node; n; n = n.parentNode) if (n === this) return true;
		return false;
	}
	appendChild(node) { return this.insertBefore(node, null); }
	insertBefore(node, ref) {
		if (node.nodeType === 11) {
			for (const c of node.childNodes.slice()) this.insertBefore(c, ref);
			return node;
		}
		if (node.parentNode) node.parentNode.removeChild(node);
		const idx = ref ? this.childNodes.indexOf(ref) : -1;
		if (idx === -1) this.childNodes.push(node);
		else this.childNodes.splice(idx, 0, node);
		node.parentNode = this;
		queueMutation({ type: 'childList', target: this, addedNodes: [node], removedNodes: [] });
		return node;
	}
	removeChild(node) {
		const idx = this.childNodes.indexOf(node);
		if (idx !== -1) {
			this.childNodes.splice(idx, 1);
			node.parentNode = null;
			queueMutation({ type: 'childList', target: this, addedNodes: [], removedNodes: [node] });
		}
		return node;
	}
	get textContent() {
		if (this.nodeType === 3) return this.nodeValue;
		return this.childNodes.map(c => c.textContent).join('');
	}
	set textContent(value) {
		if (this.nodeType === 3) { this.nodeValue = String(value); return; }
		this._replaceChildren(value === '' ? [] : [this.ownerDocument.createTextNode(String(value))]);
	}
	_replaceChildren(nodes) {
		const removed = this.childNodes;
		for (const c of removed) c.parentNode = null;
		this.childNodes = [];
		for (const n of nodes) { n.parentNode = this; this.childNodes.push(n); }
		queueMutation({ type: 'childList', target: this, addedNodes: nodes.slice(), removedNodes: removed });
	}
	_descendants(out = []) {
		for (const c of this.childNodes) {
			if (c.nodeType === 1) { out.push(c); c._descendants(out); }
		}
		return out;
	}
	querySelectorAll(selector) {
		const lists = parseSelector(selector);
		return this._descendants().filter(el => lists.some(steps => matchesSteps(el, steps, steps.length - 1)));
	}
	querySelector(selector) {
		return this.querySelectorAll(selector)[0] || null;
	}
}

class TextNode extends NodeImpl {
	constructor(text, doc) {
		super(3, doc);
		this.nodeValue = text;
	}
	get nodeName() { return '#text'; }
}

class ClassList {
	constructor(el) { this._el = el; }
	_get() { return (this._el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
	_set(list) { this._el.setAttribute('class', list.join(' ')); }
	contains(c) { return this._get().includes(c); }
	add(...cs) { const l = this._get(); for (const c of cs) if (!l.includes(c)) l.push(c); this._set(l); }
	remove(...cs) { this._set(this._get().filter(c => !cs.includes(c))); }
	toggle(c, force) {
		const has = this.contains(c);
		const want = force === undefined ? !has : !!force;
		if (want && !has) this.add(c);
		if (!want && has) this.remove(c);
		return want;
	}
}

function datasetKey(attrName) {
	return attrName.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
}

function datasetAttr(key) {
	return 'data-' + key.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());
}

class ElementImpl extends NodeImpl {
	constructor(tagName, doc) {
		super(1, doc);
		this.tagName = tagName.toUpperCase();
		this.attributes = [];
		this.style = {};
		this.classList = new ClassList(this);
		this._value = null;
		const el = this;
		this.dataset = new Proxy({}, {
			get(_, key) { return typeof key === 'string' ? (el.getAttribute(datasetAttr(key)) ?? undefined) : undefined; },
			set(_, key, value) { el.setAttribute(datasetAttr(key), String(value)); return true; },
			has(_, key) { return el.hasAttribute(datasetAttr(key)); },
			ownKeys() { return el.attributes.filter(a => a.name.startsWith('data-')).map(a => datasetKey(a.name)); },
			getOwnPropertyDescriptor(_, key) {
				const v = el.getAttribute(datasetAttr(key));
				return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true };
			},
		});
	}
	get nodeName() { return this.tagName; }
	get id() { return this.getAttribute('id') || ''; }
	set id(v) { this.setAttribute('id', v); }
	get className() { return this.getAttribute('class') || ''; }
	set className(v) { this.setAttribute('class', v); }
	get value() { return this._value !== null ? this._value : (this.getAttribute('value') || ''); }
	set value(v) { this._value = String(v); }
	getAttribute(name) {
		const a = this.attributes.find(x => x.name === name.toLowerCase());
		return a ? a.value : null;
	}
	hasAttribute(name) { return this.getAttribute(name) !== null; }
	setAttribute(name, value) {
		name = name.toLowerCase();
		const a = this.attributes.find(x => x.name === name);
		const oldValue = a ? a.value : null;
		if (a) a.value = String(value);
		else this.attributes.push({ name, value: String(value) });
		queueMutation({ type: 'attributes', target: this, attributeName: name, oldValue });
	}
	removeAttribute(name) {
		name = name.toLowerCase();
		const idx = this.attributes.findIndex(x => x.name === name);
		if (idx === -1) return;
		const oldValue = this.attributes[idx].value;
		this.attributes.splice(idx, 1);
		queueMutation({ type: 'attributes', target: this, attributeName: name, oldValue });
	}
	matches(selector) { return matchesSelector(this, selector); }
	closest(selector) {
		for (let el = this; el && el.nodeType === 1; el = el.parentNode) {
			if (matchesSelector(el, selector)) return el;
		}
		return null;
	}
	get innerHTML() { return this.childNodes.map(serialize).join(''); }
	set innerHTML(html) { this._replaceChildren(parseHTML(String(html), this.ownerDocument)); }
	get outerHTML() { return serialize(this); }
	focus() {
		const doc = this.ownerDocument;
		if (doc.activeElement === this) return;
		doc.activeElement = this;
		this.dispatchEvent(new Event('focus', { bubbles: false }));
	}
	click() {
		const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
		this.dispatchEvent(ev);
		return ev;
	}
	getBoundingClientRect() {
		return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
	}
}

export class MouseEvent extends Event {}
export class KeyboardEvent extends Event {}

class FragmentImpl extends NodeImpl {
	constructor(doc) { super(11, doc); }
}

function serialize(node) {
	if (node.nodeType === 3) return escapeText(node.nodeValue);
	const tag = node.tagName.toLowerCase();
	const attrs = node.attributes.map(a => ' ' + a.name + '="' + escapeAttr(a.value) + '"').join('');
	if (VOID_TAGS.has(tag)) return '<' + tag + attrs + '>';
	return '<' + tag + attrs + '>' + node.childNodes.map(serialize).join('') + '</' + tag + '>';
}

export function parseHTML(html, doc) {
	const root = new FragmentImpl(doc);
	const stack = [root];
	const top = () => stack[stack.length - 1];
	const attach = (parent, node) => { node.parentNode = parent; parent.childNodes.push(node); };
	let i = 0;
	while (i < html.length) {
		if (html.startsWith('<!--', i)) {
			const end = html.indexOf('-->', i + 4);
			i = end === -1 ? html.length : end + 3;
			continue;
		}
		if (html.startsWith('<!', i)) {
			const end = html.indexOf('>', i);
			i = end === -1 ? html.length : end + 1;
			continue;
		}
		if (html.startsWith('</', i)) {
			const end = html.indexOf('>', i);
			const name = html.slice(i + 2, end).trim().toUpperCase();
			for (let s = stack.length - 1; s > 0; s--) {
				if (stack[s].tagName === name) { stack.length = s; break; }
			}
			i = end === -1 ? html.length : end + 1;
			continue;
		}
		if (html[i] === '<' && /[a-zA-Z]/.test(html[i + 1] || '')) {
			// Find the closing '>' outside quotes.
			let j = i + 1;
			let quote = null;
			for (; j < html.length; j++) {
				const ch = html[j];
				if (quote) { if (ch === quote) quote = null; }
				else if (ch === '"' || ch === "'") quote = ch;
				else if (ch === '>') break;
			}
			let inner = html.slice(i + 1, j);
			const selfClosing = inner.endsWith('/');
			if (selfClosing) inner = inner.slice(0, -1);
			const nameMatch = /^[a-zA-Z][\w-]*/.exec(inner);
			const el = doc.createElement(nameMatch[0]);
			const attrRe = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
			const rest = inner.slice(nameMatch[0].length);
			let m;
			while ((m = attrRe.exec(rest))) {
				const value = m[2] ?? m[3] ?? m[4] ?? '';
				el.attributes.push({ name: m[1].toLowerCase(), value: decodeEntities(value) });
			}
			attach(top(), el);
			if (!selfClosing && !VOID_TAGS.has(nameMatch[0].toLowerCase())) stack.push(el);
			i = j + 1;
			continue;
		}
		let next = html.indexOf('<', i + 1);
		if (next === -1) next = html.length;
		attach(top(), new TextNode(decodeEntities(html.slice(i, next)), doc));
		i = next;
	}
	const nodes = root.childNodes;
	for (const n of nodes) n.parentNode = null;
	return nodes;
}

class DocumentImpl extends NodeImpl {
	constructor(window) {
		super(9, null);
		this.ownerDocument = this;
		this._window = window;
		this.documentElement = this.createElement('html');
		this.head = this.createElement('head');
		this.body = this.createElement('body');
		this.documentElement.appendChild(this.head);
		this.documentElement.appendChild(this.body);
		this.appendChild(this.documentElement);
		this.activeElement = this.body;
		this.currentScript = null;
		this.readyState = 'complete';
	}
	createElement(tag) { return new ElementImpl(tag, this); }
	createTextNode(text) { return new TextNode(String(text), this); }
	createDocumentFragment() { return new FragmentImpl(this); }
	getElementById(id) { return this.querySelector('#' + id); }
	_parentForEvents() { return this._window; }
}

class WindowImpl extends EventTargetImpl {
	constructor() {
		super();
		this.document = new DocumentImpl(this);
		this.location = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/', search: '', hash: '' };
		this.history = { pushState() {}, replaceState() {} };
	}
	scrollTo() {}
}

/**
 * Create a fresh window/document pair. `bodyHtml` becomes the body markup.
 */
export function createWindow(bodyHtml = '') {
	const win = new WindowImpl();
	win.document.body.innerHTML = bodyHtml;
	return win;
}
