var tests = (function () {
'use strict';

/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
// The first argument to JS template tags retain identity across multiple
// calls to a tag for the same literal, so we can cache work done per literal
// in a Map.
const templates = new Map();
/**
 * Interprets a template literal as an HTML template that can efficiently
 * render to and update a container.
 */
function html(strings, ...values) {
    let template = templates.get(strings);
    if (template === undefined) {
        template = new Template(strings);
        templates.set(strings, template);
    }
    return new TemplateResult(template, values);
}
/**
 * The return type of `html`, which holds a Template and the values from
 * interpolated expressions.
 */
class TemplateResult {
    constructor(template, values) {
        this.template = template;
        this.values = values;
    }
}
/**
 * Renders a template to a container.
 *
 * To update a container with new values, reevaluate the template literal and
 * call `render` with the new result.
 */
function render(result, container, partCallback = defaultPartCallback) {
    let instance = container.__templateInstance;
    // Repeat render, just call update()
    if (instance !== undefined && instance.template === result.template &&
        instance._partCallback === partCallback) {
        instance.update(result.values);
        return;
    }
    // First render, create a new TemplateInstance and append it
    instance = new TemplateInstance(result.template, partCallback);
    container.__templateInstance = instance;
    const fragment = instance._clone();
    instance.update(result.values);
    let child;
    while ((child = container.lastChild)) {
        container.removeChild(child);
    }
    container.appendChild(fragment);
}
/**
 * An expression marker with embedded unique key to avoid
 * https://github.com/PolymerLabs/lit-html/issues/62
 */
const exprMarker = `{{lit-${Math.random()}}}`;
/**
 * A placeholder for a dynamic expression in an HTML template.
 *
 * There are two built-in part types: AttributePart and NodePart. NodeParts
 * always represent a single dynamic expression, while AttributeParts may
 * represent as many expressions are contained in the attribute.
 *
 * A Template's parts are mutable, so parts can be replaced or modified
 * (possibly to implement different template semantics). The contract is that
 * parts can only be replaced, not removed, added or reordered, and parts must
 * always consume the correct number of values in their `update()` method.
 *
 * TODO(justinfagnani): That requirement is a little fragile. A
 * TemplateInstance could instead be more careful about which values it gives
 * to Part.update().
 */
class TemplatePart {
    constructor(type, index, name, rawName, strings) {
        this.type = type;
        this.index = index;
        this.name = name;
        this.rawName = rawName;
        this.strings = strings;
    }
}
class Template {
    constructor(strings) {
        this.parts = [];
        this.element = document.createElement('template');
        this.element.innerHTML = strings.join(exprMarker);
        const walker = document.createTreeWalker(this.element.content, 5 /* elements & text */);
        let index = -1;
        let partIndex = 0;
        const nodesToRemove = [];
        while (walker.nextNode()) {
            index++;
            const node = walker.currentNode;
            if (node.nodeType === 1 /* ELEMENT_NODE */) {
                if (!node.hasAttributes())
                    continue;
                const attributes = node.attributes;
                for (let i = 0; i < attributes.length; i++) {
                    const attribute = attributes.item(i);
                    const attributeStrings = attribute.value.split(exprMarker);
                    if (attributeStrings.length > 1) {
                        // Get the template literal section leading up to the first
                        // expression in this attribute attribute
                        const attributeString = strings[partIndex];
                        // Trim the trailing literal value if this is an interpolation
                        const rawNameString = attributeString.substring(0, attributeString.length - attributeStrings[0].length);
                        // Find the attribute name
                        const rawName = rawNameString.match(/((?:\w|[.\-_$])+)=["']?$/)[1];
                        this.parts.push(new TemplatePart('attribute', index, attribute.name, rawName, attributeStrings));
                        node.removeAttribute(attribute.name);
                        partIndex += attributeStrings.length - 1;
                        i--;
                    }
                }
            }
            else if (node.nodeType === 3 /* TEXT_NODE */) {
                const strings = node.nodeValue.split(exprMarker);
                if (strings.length > 1) {
                    const parent = node.parentNode;
                    const lastIndex = strings.length - 1;
                    // We have a part for each match found
                    partIndex += lastIndex;
                    // We keep this current node, but reset its content to the last
                    // literal part. We insert new literal nodes before this so that the
                    // tree walker keeps its position correctly.
                    node.textContent = strings[lastIndex];
                    // Generate a new text node for each literal section
                    // These nodes are also used as the markers for node parts
                    for (let i = 0; i < lastIndex; i++) {
                        parent.insertBefore(new Text(strings[i]), node);
                        this.parts.push(new TemplatePart('node', index++));
                    }
                }
                else if (!node.nodeValue.trim()) {
                    nodesToRemove.push(node);
                    index--;
                }
            }
        }
        // Remove text binding nodes after the walk to not disturb the TreeWalker
        for (const n of nodesToRemove) {
            n.parentNode.removeChild(n);
        }
    }
}
const getValue = (part, value) => {
    // `null` as the value of a Text node will render the string 'null'
    // so we convert it to undefined
    if (value != null && value.__litDirective === true) {
        value = value(part);
    }
    return value === null ? undefined : value;
};
const directive = (f) => {
    f.__litDirective = true;
    return f;
};
class AttributePart {
    constructor(instance, element, name, strings) {
        this.instance = instance;
        this.element = element;
        this.name = name;
        this.strings = strings;
        this.size = strings.length - 1;
    }
    setValue(values, startIndex) {
        const strings = this.strings;
        let text = '';
        for (let i = 0; i < strings.length; i++) {
            text += strings[i];
            if (i < strings.length - 1) {
                const v = getValue(this, values[startIndex + i]);
                if (v &&
                    (Array.isArray(v) || typeof v !== 'string' && v[Symbol.iterator])) {
                    for (const t of v) {
                        // TODO: we need to recursively call getValue into iterables...
                        text += t;
                    }
                }
                else {
                    text += v;
                }
            }
        }
        this.element.setAttribute(this.name, text);
    }
}
class NodePart {
    constructor(instance, startNode, endNode) {
        this.instance = instance;
        this.startNode = startNode;
        this.endNode = endNode;
    }
    setValue(value) {
        value = getValue(this, value);
        if (value === null ||
            !(typeof value === 'object' || typeof value === 'function')) {
            // Handle primitive values
            // If the value didn't change, do nothing
            if (value === this._previousValue) {
                return;
            }
            this._setText(value);
        }
        else if (value instanceof TemplateResult) {
            this._setTemplateResult(value);
        }
        else if (Array.isArray(value) || value[Symbol.iterator]) {
            this._setIterable(value);
        }
        else if (value instanceof Node) {
            this._setNode(value);
        }
        else if (value.then !== undefined) {
            this._setPromise(value);
        }
        else {
            // Fallback, will render the string representation
            this._setText(value);
        }
    }
    _insert(node) {
        this.endNode.parentNode.insertBefore(node, this.endNode);
    }
    _setNode(value) {
        this.clear();
        this._insert(value);
        this._previousValue = value;
    }
    _setText(value) {
        const node = this.startNode.nextSibling;
        if (node === this.endNode.previousSibling &&
            node.nodeType === Node.TEXT_NODE) {
            // If we only have a single text node between the markers, we can just
            // set its value, rather than replacing it.
            // TODO(justinfagnani): Can we just check if _previousValue is
            // primitive?
            node.textContent = value;
        }
        else {
            this._setNode(new Text(value));
        }
        this._previousValue = value;
    }
    _setTemplateResult(value) {
        let instance;
        if (this._previousValue &&
            this._previousValue.template === value.template) {
            instance = this._previousValue;
        }
        else {
            instance =
                new TemplateInstance(value.template, this.instance._partCallback);
            this._setNode(instance._clone());
            this._previousValue = instance;
        }
        instance.update(value.values);
    }
    _setIterable(value) {
        // For an Iterable, we create a new InstancePart per item, then set its
        // value to the item. This is a little bit of overhead for every item in
        // an Iterable, but it lets us recurse easily and efficiently update Arrays
        // of TemplateResults that will be commonly returned from expressions like:
        // array.map((i) => html`${i}`), by reusing existing TemplateInstances.
        // If _previousValue is an array, then the previous render was of an
        // iterable and _previousValue will contain the NodeParts from the previous
        // render. If _previousValue is not an array, clear this part and make a new
        // array for NodeParts.
        if (!Array.isArray(this._previousValue)) {
            this.clear();
            this._previousValue = [];
        }
        // Lets of keep track of how many items we stamped so we can clear leftover
        // items from a previous render
        const itemParts = this._previousValue;
        let partIndex = 0;
        for (const item of value) {
            // Try to reuse an existing part
            let itemPart = itemParts[partIndex];
            // If no existing part, create a new one
            if (itemPart === undefined) {
                // If we're creating the first item part, it's startNode should be the
                // container's startNode
                let itemStart = this.startNode;
                // If we're not creating the first part, create a new separator marker
                // node, and fix up the previous part's endNode to point to it
                if (partIndex > 0) {
                    const previousPart = itemParts[partIndex - 1];
                    itemStart = previousPart.endNode = new Text();
                    this._insert(itemStart);
                }
                itemPart = new NodePart(this.instance, itemStart, this.endNode);
                itemParts.push(itemPart);
            }
            itemPart.setValue(item);
            partIndex++;
        }
        if (partIndex === 0) {
            this.clear();
            this._previousValue = undefined;
        }
        else if (partIndex < itemParts.length) {
            const lastPart = itemParts[partIndex - 1];
            this.clear(lastPart.endNode.previousSibling);
            lastPart.endNode = this.endNode;
        }
    }
    _setPromise(value) {
        value.then((v) => {
            if (this._previousValue === value) {
                this.setValue(v);
            }
        });
        this._previousValue = value;
    }
    clear(startNode = this.startNode) {
        let node;
        while ((node = startNode.nextSibling) !== this.endNode) {
            node.parentNode.removeChild(node);
        }
    }
}
const defaultPartCallback = (instance, templatePart, node) => {
    if (templatePart.type === 'attribute') {
        return new AttributePart(instance, node, templatePart.name, templatePart.strings);
    }
    else if (templatePart.type === 'node') {
        return new NodePart(instance, node, node.nextSibling);
    }
    throw new Error(`Unknown part type ${templatePart.type}`);
};
/**
 * An instance of a `Template` that can be attached to the DOM and updated
 * with new values.
 */
class TemplateInstance {
    constructor(template, partCallback = defaultPartCallback) {
        this._parts = [];
        this.template = template;
        this._partCallback = partCallback;
    }
    update(values) {
        let valueIndex = 0;
        for (const part of this._parts) {
            if (part.size === undefined) {
                part.setValue(values[valueIndex]);
                valueIndex++;
            }
            else {
                part.setValue(values, valueIndex);
                valueIndex += part.size;
            }
        }
    }
    _clone() {
        const fragment = document.importNode(this.template.element.content, true);
        if (this.template.parts.length > 0) {
            const walker = document.createTreeWalker(fragment, 5 /* elements & text */);
            const parts = this.template.parts;
            let index = 0;
            let partIndex = 0;
            let templatePart = parts[0];
            let node = walker.nextNode();
            while (node != null && partIndex < parts.length) {
                if (index === templatePart.index) {
                    this._parts.push(this._partCallback(this, templatePart, node));
                    templatePart = parts[++partIndex];
                }
                else {
                    index++;
                    node = walker.nextNode();
                }
            }
        }
        return fragment;
    }
}

/**
 * @license
 * Copyright (c) 2017 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at
 * http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at
 * http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at
 * http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at
 * http://polymer.github.io/PATENTS.txt
 */
const stateCache = new WeakMap();
function repeat(items, keyFnOrTemplate, template) {
    let keyFn;
    if (arguments.length === 2) {
        template = keyFnOrTemplate;
    }
    else if (arguments.length === 3) {
        keyFn = keyFnOrTemplate;
    }
    return directive((part) => {
        let state = stateCache.get(part);
        if (state === undefined) {
            state = {
                keyMap: keyFn && new Map(),
                parts: [],
            };
            stateCache.set(part, state);
        }
        const container = part.startNode.parentNode;
        const oldParts = state.parts;
        const endParts = new Map(oldParts.map((p) => [p.endNode, p]));
        const keyMap = state.keyMap;
        const itemParts = [];
        let index = 0;
        let oldPartsIndex = 0;
        let currentMarker;
        for (const item of items) {
            let result;
            let key;
            try {
                result = template(item, index++);
                key = keyFn && keyFn(item);
            }
            catch (e) {
                console.error(e);
                continue;
            }
            // Try to reuse a part, either keyed or from the list of previous parts
            // if there's no keyMap
            let itemPart = keyMap === undefined ? oldParts[oldPartsIndex++] : keyMap.get(key);
            if (itemPart === undefined) {
                // New part, attach it
                if (currentMarker === undefined) {
                    currentMarker = new Text();
                    container.insertBefore(currentMarker, part.startNode.nextSibling);
                }
                const endNode = new Text();
                container.insertBefore(endNode, currentMarker.nextSibling);
                itemPart = new NodePart(part.instance, currentMarker, endNode);
                if (key !== undefined && keyMap !== undefined) {
                    keyMap.set(key, itemPart);
                }
            }
            else {
                // Existing part, maybe move it
                const range = document.createRange();
                range.setStartBefore(itemPart.startNode);
                range.setEndBefore(itemPart.endNode);
                if (currentMarker === undefined) {
                    // this should be the first part, make sure it's first
                    if (part.startNode.nextSibling !== itemPart.startNode) {
                        // move the whole part
                        // get previous and next parts
                        const previousPart = endParts.get(itemPart.startNode);
                        if (previousPart) {
                            previousPart.endNode = itemPart.endNode;
                            endParts.set(previousPart.endNode, previousPart);
                        }
                        const contents = range.extractContents();
                        if (part.startNode.nextSibling === part.endNode) {
                            // The container part was empty, so we need a new endPart
                            itemPart.endNode = new Text();
                            container.insertBefore(itemPart.endNode, part.startNode.nextSibling);
                        }
                        else {
                            // endNode should equal the startNode of the currently first part
                            itemPart.endNode = part.startNode.nextSibling;
                        }
                        container.insertBefore(contents, part.startNode.nextSibling);
                    }
                    // else part is in the correct position already
                }
                else if (currentMarker !== itemPart.startNode) {
                    // move to correct position
                    const previousPart = endParts.get(itemPart.startNode);
                    if (previousPart) {
                        previousPart.endNode = itemPart.endNode;
                        endParts.set(previousPart.endNode, previousPart);
                    }
                    const contents = range.extractContents();
                    container.insertBefore(contents, currentMarker);
                }
                // remove part from oldParts list so it's not cleaned up
                oldParts.splice(oldParts.indexOf(itemPart), 1);
            }
            // else part is in the correct position already
            itemPart.setValue(result);
            itemParts.push(itemPart);
            currentMarker = itemPart.endNode;
        }
        // Cleanup
        if (oldParts.length > 0) {
            const clearStart = oldParts[0].startNode;
            const clearEnd = oldParts[oldParts.length - 1].endNode;
            const clearRange = document.createRange();
            if (itemParts.length === 0) {
                clearRange.setStartBefore(clearStart);
            }
            else {
                clearRange.setStartAfter(clearStart);
            }
            clearRange.setEndAfter(clearEnd);
            clearRange.deleteContents();
            clearRange.detach(); // is this neccessary?
        }
        state.parts = itemParts;
    });
}

var commonjsGlobal = typeof window !== 'undefined' ? window : typeof global !== 'undefined' ? global : typeof self !== 'undefined' ? self : {};





function createCommonjsModule(fn, module) {
	return module = { exports: {} }, fn(module, module.exports), module.exports;
}

var unexpected$1 = createCommonjsModule(function (module, exports) {
/*!
 * Copyright (c) 2013 Sune Simonsen <sune@we-knowhow.dk>
 * 
 * Permission is hereby granted, free of charge, to any person
 * obtaining a copy of this software and associated documentation
 * files (the 'Software'), to deal in the Software without
 * restriction, including without limitation the rights to use, copy,
 * modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be
 * included in all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
 * EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
 * BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
 * ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
!function(t,e){module.exports=e();}(commonjsGlobal,function(){"use strict";function t(t,e){return e={exports:{}},t(e,e.exports),e.exports}function e(){throw new Error("setTimeout has not been defined")}function n(){throw new Error("clearTimeout has not been defined")}function r(t){if(gn===setTimeout)return setTimeout(t,0);if((gn===e||!gn)&&setTimeout)return gn=setTimeout,setTimeout(t,0);try{return gn(t,0)}catch(e){try{return gn.call(null,t,0)}catch(e){return gn.call(this,t,0)}}}function i(t){if(vn===clearTimeout)return clearTimeout(t);if((vn===n||!vn)&&clearTimeout)return vn=clearTimeout,clearTimeout(t);try{return vn(t)}catch(e){try{return vn.call(null,t)}catch(e){return vn.call(this,t)}}}function o(){bn&&_n&&(bn=!1,_n.length?mn=_n.concat(mn):wn=-1,mn.length&&s());}function s(){if(!bn){var t=r(o);bn=!0;for(var e=mn.length;e;){for(_n=mn,mn=[];++wn<e;)_n&&_n[wn].run();wn=-1,e=mn.length;}_n=null,bn=!1,i(t);}}function a(t){var e=new Array(arguments.length-1);if(arguments.length>1)for(var n=1;n<arguments.length;n++)e[n-1]=arguments[n];mn.push(new u(t,e)),1!==mn.length||bn||r(s);}function u(t,e){this.fun=t,this.array=e;}function c(){}function f(t){throw new Error("process.binding is not supported")}function l(){return"/"}function h(t){throw new Error("process.chdir is not supported")}function p(){return 0}function d(t){var e=.001*Nn.call(Ln),n=Math.floor(e),r=Math.floor(e%1*1e9);return t&&(n-=t[0],(r-=t[1])<0&&(n--,r+=1e9)),[n,r]}function y(){return(new Date-Un)/1e3}function g(t,e){if(e<0)return"";var n="";if(" "===t){if(e<=Yn)return Wn[e];for(var r=Wn[Yn],i=Math.floor(e/Yn),o=0;o<i;o+=1)n+=r;n+=Wn[e%Yn];}else for(var s=0;s<e;s+=1)n+=t;return n}function v(t){return{style:"text",args:{content:Kn(" ",t),styles:[]}}}function m(t){return t.some(function(t){return"block"===t.style||"text"===t.style&&-1!==String(t.args.content).indexOf("\n")})}function b(t){switch(t.style){case"text":return String(t.args.content).split("\n").map(function(e){return""===e?[]:[{style:"text",args:{content:e,styles:t.args.styles}}]});case"block":return w(t.args);default:return[]}}function _(t){if(0===t.length)return[[]];if(!m(t))return[t];var e=[],n=[],r=0;return t.forEach(function(t,i){var o=b(t),s=o.map(function(t){return $n.calculateLineSize(t).width}),a=Math.max.apply(null,s);o.forEach(function(t,i){var o=e[i];if(o||(e[i]=o=[],n[i]=0),t.length){var a=r-n[i];o.push(v(a)),Array.prototype.push.apply(o,t),n[i]=r+s[i];}}),r+=a;},this),e}function w(t){var e=[];return t.forEach(function(t){_(t).forEach(function(t){e.push(t);});}),e}function E(){}function x(t){this.theme=t;}function A(t,e){var n=t.L,r=t.a,i=t.b,o=e.L,s=e.a,a=e.b,u=or(sr(r,2)+sr(i,2)),c=or(sr(s,2)+sr(a,2)),f=(u+c)/2,l=.5*(1-or(sr(f,7)/(sr(f,7)+sr(25,7)))),h=(1+l)*r,p=(1+l)*s,d=or(sr(h,2)+sr(i,2)),y=or(sr(p,2)+sr(a,2)),g=function(t,e){if(0==t&&0==e)return 0;var n=F(ur(t,e));return n>=0?n:n+360},v=g(i,h),m=g(a,p),b=o-n,_=y-d,w=function(t,e,n,r){if(t*e==0)return 0;if(fr(r-n)<=180)return r-n;if(r-n>180)return r-n-360;if(r-n<-180)return r-n+360;throw new Error}(u,c,v,m),E=2*or(d*y)*cr(j(w)/2),x=(n+o)/2,A=(d+y)/2,k=function(t,e,n,r){if(t*e==0)return n+r;if(fr(n-r)<=180)return(n+r)/2;if(fr(n-r)>180&&n+r<360)return(n+r+360)/2;if(fr(n-r)>180&&n+r>=360)return(n+r-360)/2;throw new Error}(u,c,v,m),C=1-.17*ar(j(k-30))+.24*ar(j(2*k))+.32*ar(j(3*k+6))-.2*ar(j(4*k-63)),S=30*lr(-sr((k-275)/25,2)),T=or(sr(A,7)/(sr(A,7)+sr(25,7))),O=1+.015*sr(x-50,2)/or(20+sr(x-50,2)),P=1+.045*A,D=1+.015*A*C,M=-2*T*cr(j(2*S));return or(sr(b/(1*O),2)+sr(_/(1*P),2)+sr(E/(1*D),2)+M*(_/(1*P))*(E/(1*D)))}function F(t){return t*(180/hr)}function j(t){return t*(hr/180)}function k(t){return S(C(t))}function C(t){var e=t.R/255,n=t.G/255,r=t.B/255;return e>.04045?e=yr((e+.055)/1.055,2.4):e/=12.92,n>.04045?n=yr((n+.055)/1.055,2.4):n/=12.92,r>.04045?r=yr((r+.055)/1.055,2.4):r/=12.92,{X:.4124*(e*=100)+.3576*(n*=100)+.1805*(r*=100),Y:.2126*e+.7152*n+.0722*r,Z:.0193*e+.1192*n+.9505*r}}function S(t){var e=t.Y/100,n=t.Z/108.883,r=t.X/95.047;return r=r>.008856?yr(r,1/3):7.787*r+16/116,{L:116*(e=e>.008856?yr(e,1/3):7.787*e+16/116)-16,a:500*(r-e),b:200*(e-(n=n>.008856?yr(n,1/3):7.787*n+16/116))}}function T(t){return"R"+t.R+"B"+t.B+"G"+t.G}function O(t,e,n){var r={};n=n||"closest";for(var i=0;i<t.length;i+=1){for(var o=t[i],s=void 0,a=void 0,u=0;u<e.length;u+=1){var c=e[u],f=P(o,c);void 0==s||"closest"===n&&f<a?(s=c,a=f):"furthest"===n&&f>a&&(s=c,a=f);}r[T(o)]=s;}return r}function P(t,e){return t=gr.rgb_to_lab(t),e=gr.rgb_to_lab(e),pr.ciede2000(t,e)}function D(t){this.theme=t;}function M(t){t.length<6&&(t=t.replace(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i,"$1$1$2$2$3$3"));var e=t.match(/^#?([0-9a-f][0-9a-f])([0-9a-f][0-9a-f])([0-9a-f][0-9a-f])$/i);if(e)return{R:parseInt(e[1],16),G:parseInt(e[2],16),B:parseInt(e[3],16)}}function R(t){var e=(65536*Math.round(t.R)+256*Math.round(t.G)+Math.round(t.B)).toString(16);return"#"+"00000".substr(0,6-e.length)+e}function B(t){return t.substring(0,1).toUpperCase()+t.substring(1)}function I(t){jr[256].push(t),Fr[256][R(t)]=kr,kr+=1;}function L(t){this.theme=t;}function N(){try{var t=zr;return zr=null,t.apply(this,arguments)}catch(t){return Ur.e=t,Ur}}function U(t){return zr=t,N}function z(t){return null==t||!0===t||!1===t||"string"==typeof t||"number"==typeof t}function q(t){return!z(t)}function H(t){return z(t)?new Error(X(t)):t}function $(t,e){var n,r=t.length,i=new Array(r+1);for(n=0;n<r;++n)i[n]=t[n];return i[n]=e,i}function Y(t,e,n){if(!Ir.isES5)return{}.hasOwnProperty.call(t,e)?t[e]:void 0;var r=Object.getOwnPropertyDescriptor(t,e);return null!=r?null==r.get&&null==r.set?r.value:n:void 0}function W(t,e,n){if(z(t))return t;var r={value:n,configurable:!0,enumerable:!1,writable:!0};return Ir.defineProperty(t,e,r),t}function V(t){throw t}function K(t){try{if("function"==typeof t){var e=Ir.names(t.prototype),n=Ir.isES5&&e.length>1,r=e.length>0&&!(1===e.length&&"constructor"===e[0]),i=$r.test(t+"")&&Ir.names(t).length>0;if(n||r||i)return!0}return!1}catch(t){return!1}}function Q(t){function e(){}e.prototype=t;for(var n=8;n--;)new e;return t}function J(t){return Yr.test(t)}function G(t,e,n){for(var r=new Array(t),i=0;i<t;++i)r[i]=e+i+n;return r}function X(t){try{return t+""}catch(t){return"[no string representation]"}}function Z(t){try{W(t,"isOperational",!0);}catch(t){}}function tt(t){return null!=t&&(t instanceof Error.__BluebirdErrorTypes__.OperationalError||!0===t.isOperational)}function et(t){return t instanceof Error&&Ir.propertyIsWritable(t,"stack")}function nt(t){return{}.toString.call(t)}function rt(t,e,n){for(var r=Ir.names(t),i=0;i<r.length;++i){var o=r[i];if(n(o))try{Ir.defineProperty(e,o,Ir.getDescriptor(t,o));}catch(t){}}}function it(t,e,n,r,i){for(var o=0;o<i;++o)n[o+r]=t[o+e],t[o+e]=void 0;}function ot(t){this._capacity=t,this._length=0,this._front=0;}function st(){this._isTickUsed=!1,this._lateQueue=new ti(16),this._normalQueue=new ti(16),this._trampolineEnabled=!0;var t=this;this.drainQueues=function(){t._drainQueues();},this._schedule=ni.isStatic?ni(this.drainQueues):ni;}function at(t,e,n){this._lateQueue.push(t,e,n),this._queueTick();}function ut(t,e,n){this._normalQueue.push(t,e,n),this._queueTick();}function ct(t){this._normalQueue._pushOne(t),this._queueTick();}function ft(t,e){function n(r){if(!(this instanceof n))return new n(r);ai(this,"message","string"==typeof r?r:e),ai(this,"name",t),Error.captureStackTrace?Error.captureStackTrace(this,this.constructor):Error.call(this);}return si(n,Error),n}function lt(t){if(!(this instanceof lt))return new lt(t);ai(this,"name","OperationalError"),ai(this,"message",t),this.cause=t,this.isOperational=!0,t instanceof Error?(ai(this,"message",t.message),ai(this,"stack",t.stack)):Error.captureStackTrace&&Error.captureStackTrace(this,this.constructor);}function ht(t){return t instanceof Error&&Ir.getPrototypeOf(t)===Error.prototype}function pt(t){var e;if(ht(t)){(e=new ki(t)).name=t.name,e.message=t.message,e.stack=t.stack;for(var n=Ir.keys(t),r=0;r<n.length;++r){var i=n[r];Si.test(i)||(e[i]=t[i]);}return e}return Kr.markAsOriginatingFromRejection(t),t}function dt(t){return function(e,n){if(null!==t){if(e){var r=pt(Fi(e));t._attachExtraTrace(r),t._reject(r);}else if(arguments.length>2){for(var i=arguments.length,o=new Array(i-1),s=1;s<i;++s)o[s-1]=arguments[s];t._fulfill(o);}else t._fulfill(n);t=null;}}}function yt(){try{Promise===uo&&(Promise=ao);}catch(t){}return uo}function gt(t){if(t&&"aggregate error"===t.message)for(var e=0;e<t.length;e+=1)gt(t[e]);else if(!t||!t._isUnexpected)throw t}function vt(t){if("function"!=typeof t)throw new TypeError("expect.promise(...) requires a function argument to be supplied.\nSee http://unexpected.js.org/api/promise/ for more details.");return new co(2===t.length?t:function(e,n){function r(){a&&0===s&&e(o);}function i(t){void 0!==t&&void 0===o&&(o=t);}var o,s=0,a=!1;try{var u=go(t(function(t){return s+=1,function(){s-=1;var e;try{"function"==typeof t&&(mt(e=go(t.apply(null,arguments)))?(s+=1,e.then(function(t){i(t),s-=1,r();},n)):i(e));}catch(t){return n(t)}return r(),e}}));mt(u)?(s+=1,u.then(function(t){i(t),s-=1,r();},n)):i(u);}catch(t){return n(t)}a=!0,r();})}function mt(t){return t&&"object"===(void 0===t?"undefined":mo(t))&&"function"==typeof t.then}function bt(t){if(mt(t))return[t];if(t&&"object"===(void 0===t?"undefined":mo(t))){var e=[];return Object.keys(t).forEach(function(n){Array.prototype.push.apply(e,bt(t[n]));}),e}return[]}function _t(t,e,n){return t.and=function(){function t(){return e.findTypeOf(i[0]).is("expect.it")?_t(i[0](n),e,n):e.apply(e,[n].concat(i))}for(var r=arguments.length,i=Array(r),o=0;o<r;o++)i[o]=arguments[o];return this.isFulfilled()?t():_t(this.then(t),e,n)},t}function wt(t,e){this.errorMode=t&&t.errorMode||"default";var n=Error.call(this,"");if(Error.captureStackTrace)Error.captureStackTrace(this,wt);else{try{throw n}catch(t){}this.stack=n.stack;}this.expect=t,this.parent=e||null,this.name="UnexpectedError";}function Et(t){for(var e=t.length-1;0<=e;e-=1)if(""===t[e])return e+1;return-1}function xt(t){return t.isPending()||t.isRejected()&&t.reason().uncaught}function At(){if("function"==typeof afterEach&&!Oo){Oo=!0;try{afterEach(function(){var t,e=!0;if(To.some(xt)){var n;this.currentTest?(e="passed"===this.currentTest.state,n=this.currentTest.title):"object"===(void 0===Po?"undefined":So(Po))&&(e=0===Po.failedExpectations.length,n=Po.fullName),t=new Error(n+": You have created a promise that was not returned from the it block");}if(To=[],t&&e)throw t});}catch(t){}}}function Ft(t){return t.type.is("assertion")}function jt(t,e){for(var n=[],r=e;r;r=r.parent)r.assertions[t]&&Array.prototype.push.apply(n,r.assertions[t]);return n}function kt(t,e){if("string"!=typeof t)return null;var n=jt(t,e);if(n.length>0)return n;for(var r=t.split(" "),i=r.length-1;i>0;i-=1){var o=jt(r.slice(i).join(" "),e);if(kt(r.slice(0,i).join(" "),e)&&o.length>0)return o}return null}function Ct(t){return t.type.is("assertion")}function St(t){this.expect=t,this.level=0;}function Tt(t){t=t||{},this.assertions=t.assertions||{},this.typeByName=t.typeByName||{any:Lo},this.types=t.types||[Lo],t.output?this.output=t.output:(this.output=Dr(),this.output.inline=!1,this.output.diff=!1),this._outputFormat=t.format||Dr.defaultFormat,this.installedPlugins=t.installedPlugins||[];var e=this;this.getType=function(t){return e.typeByName[t]||e.parent&&e.parent.getType(t)},this.findTypeOf=function(t){return dn.findFirst(e.types||[],function(e){return e.identify&&e.identify(t)})||e.parent&&e.parent.findTypeOf(t)},this.findTypeOfWithParentType=function(t,n){return dn.findFirst(e.types||[],function(e){return e.identify&&e.identify(t)&&(!n||e.is(n))})||e.parent&&e.parent.findTypeOfWithParentType(t,n)},this.findCommonType=function(t,e){for(var n={},r=this.findTypeOf(t);r;)n[r.name]=r,r=r.baseType;for(r=this.findTypeOf(e);r;){if(n[r.name])return r;r=r.baseType;}},this._wrappedExpectProto=Ro(this);}function Ot(t){var e=[[]];return t.forEach(function(t){t===No?e.push([]):e[e.length-1].push(t);}),e}function Pt(t,e,n,r){return r.map(function(r){var i=Array.prototype.slice.call(r);return i.unshift(n),{expectation:i,promise:bo(function(){if("function"==typeof i[1]){if(i.length>2)throw new Error("expect.it(<function>) does not accept additional arguments");return i[1](i[0])}return t._expect(e.child(),i)})}})}function Dt(t,e){var n=e.length>1,r=e.some(function(t){return t.length>1});e.forEach(function(e,i){i>0&&(r?t.nl():t.sp(),t.jsComment("or").nl());var o=!1;e.forEach(function(e,i){i>0&&t.jsComment(" and").nl();var s=e.promise.isRejected();if(s&&!o){o=!0;var a=e.promise.reason();(r||n)&&t.error("⨯ "),t.block(function(t){t.append(a.getErrorMessage(t));});}else{s?t.error("⨯ "):t.success("✓ ");var u=e.expectation;t.block(function(t){var e=u[0],n=u.slice(2).map(function(t){return function(e){e.appendInspected(t);}}),r=u[1];un(t,function(t){t.appendInspected(e);},r,n,{subject:e});});}});});}function Mt(t,e){function n(e,n){n=n&&"object"===(void 0===n?"undefined":Bo(n))&&n instanceof St?n:new St(t);var i=[],o=[];return r.forEach(function(r){var s=Pt(t,n,e,r);s.forEach(function(t){o.push(t.promise);}),i.push(s);}),go(bo.settle(o).then(function(){i.forEach(function(t){t.forEach(function(t){if(t.promise.isRejected()&&"bubbleThrough"===t.promise.reason().errorMode)throw t.promise.reason()});}),i.some(function(t){return t.every(function(t){return t.promise.isFulfilled()})})||t.fail(function(t){Dt(t,i);});}))}var r=Ot(e);return n._expectIt=!0,n._expectations=e,n._OR=No,n.and=function(){var n=e.slice();return n.push(arguments),Mt(t,n)},n.or=function(){var n=e.slice();return n.push(No,arguments),Mt(t,n)},n}function Rt(t,e){for(var n=0;n<Math.min(t.length,e.length);n+=1){var r=e[n]-t[n];if(0!==r)return r}return e.length-t.length}function Bt(t){return[t.subject.type.level].concat(t.args.map(function(t){return(1===t.minimum&&1===t.maximum?.5:0)+t.type.level}))}function It(t){return"function"==typeof t?dn.getFunctionName(t):t.name}function Lt(t){var e=function(){return t._expect(new St(t),arguments)};return e.it=t.it.bind(t),e.equal=t.equal.bind(t),e.inspect=t.inspect.bind(t),e.findTypeOf=t.findTypeOf,e.fail=function(){try{t.fail.apply(t,arguments);}catch(e){throw e&&e._isUnexpected&&t.setErrorMessage(e),e}},e.createOutput=t.createOutput.bind(t),e.diff=t.diff.bind(t),e.async=t.async.bind(t),e.promise=bo,e.withError=t.withError,e.addAssertion=t.addAssertion.bind(t),e.addStyle=t.addStyle.bind(t),e.installTheme=t.installTheme.bind(t),e.addType=t.addType.bind(t),e.getType=t.getType,e.clone=t.clone.bind(t),e.child=t.child.bind(t),e.toString=t.toString.bind(t),e.assertions=t.assertions,e.use=e.installPlugin=t.use.bind(t),e.output=t.output,e.outputFormat=t.outputFormat.bind(t),e.notifyPendingPromise=Do,e.hook=function(e){t._expect=e(t._expect.bind(t));},e.parseAssertion=t.parseAssertion.bind(t),e}function Nt(t){return t.reduce(function(t,e){return t.minimum+=e.minimum,t.maximum+=e.maximum,t},{minimum:0,maximum:0})}function Ut(t){var e=Lt(t);return t.expect=e,e}function zt(t){for(var e={"[":0,"]":0,"(":0,")":0},n=0;n<t.length;n+=1){var r=t.charAt(n);if(r in e&&(e[r]+=1),"]"===r&&e["["]>=e["]"]){if(e["["]===e["]"]+1)throw new Error("Assertion patterns must not contain flags with brackets: '"+t+"'");if(e["("]!==e[")"])throw new Error("Assertion patterns must not contain flags with parentheses: '"+t+"'");if("["===t.charAt(n-1))throw new Error("Assertion patterns must not contain empty flags: '"+t+"'")}else if(")"===r&&e["("]>=e[")"]){if(e["("]===e[")"]+1)throw new Error("Assertion patterns must not contain alternations with parentheses: '"+t+"'");if(e["["]!==e["]"])throw new Error("Assertion patterns must not contain alternations with brackets: '"+t+"'")}}if(e["["]!==e["]"])throw new Error("Assertion patterns must not contain unbalanced brackets: '"+t+"'");if(e["("]!==e[")"])throw new Error("Assertion patterns must not contain unbalanced parentheses: '"+t+"'")}function qt(){Go=!0;for(var t="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/",e=0,n=t.length;e<n;++e)Ko[e]=t[e],Qo[t.charCodeAt(e)]=e;Qo["-".charCodeAt(0)]=62,Qo["_".charCodeAt(0)]=63;}function Ht(t){Go||qt();var e,n,r,i,o,s,a=t.length;if(a%4>0)throw new Error("Invalid string. Length must be a multiple of 4");o="="===t[a-2]?2:"="===t[a-1]?1:0,s=new Jo(3*a/4-o),r=o>0?a-4:a;var u=0;for(e=0,n=0;e<r;e+=4,n+=3)i=Qo[t.charCodeAt(e)]<<18|Qo[t.charCodeAt(e+1)]<<12|Qo[t.charCodeAt(e+2)]<<6|Qo[t.charCodeAt(e+3)],s[u++]=i>>16&255,s[u++]=i>>8&255,s[u++]=255&i;return 2===o?(i=Qo[t.charCodeAt(e)]<<2|Qo[t.charCodeAt(e+1)]>>4,s[u++]=255&i):1===o&&(i=Qo[t.charCodeAt(e)]<<10|Qo[t.charCodeAt(e+1)]<<4|Qo[t.charCodeAt(e+2)]>>2,s[u++]=i>>8&255,s[u++]=255&i),s}function $t(t){return Ko[t>>18&63]+Ko[t>>12&63]+Ko[t>>6&63]+Ko[63&t]}function Yt(t,e,n){for(var r,i=[],o=e;o<n;o+=3)r=(t[o]<<16)+(t[o+1]<<8)+t[o+2],i.push($t(r));return i.join("")}function Wt(t){Go||qt();for(var e,n=t.length,r=n%3,i="",o=[],s=0,a=n-r;s<a;s+=16383)o.push(Yt(t,s,s+16383>a?a:s+16383));return 1===r?(e=t[n-1],i+=Ko[e>>2],i+=Ko[e<<4&63],i+="=="):2===r&&(e=(t[n-2]<<8)+t[n-1],i+=Ko[e>>10],i+=Ko[e>>4&63],i+=Ko[e<<2&63],i+="="),o.push(i),o.join("")}function Vt(t,e,n,r,i){var o,s,a=8*i-r-1,u=(1<<a)-1,c=u>>1,f=-7,l=n?i-1:0,h=n?-1:1,p=t[e+l];for(l+=h,o=p&(1<<-f)-1,p>>=-f,f+=a;f>0;o=256*o+t[e+l],l+=h,f-=8);for(s=o&(1<<-f)-1,o>>=-f,f+=r;f>0;s=256*s+t[e+l],l+=h,f-=8);if(0===o)o=1-c;else{if(o===u)return s?NaN:1/0*(p?-1:1);s+=Math.pow(2,r),o-=c;}return(p?-1:1)*s*Math.pow(2,o-r)}function Kt(t,e,n,r,i,o){var s,a,u,c=8*o-i-1,f=(1<<c)-1,l=f>>1,h=23===i?Math.pow(2,-24)-Math.pow(2,-77):0,p=r?0:o-1,d=r?1:-1,y=e<0||0===e&&1/e<0?1:0;for(e=Math.abs(e),isNaN(e)||e===1/0?(a=isNaN(e)?1:0,s=f):(s=Math.floor(Math.log(e)/Math.LN2),e*(u=Math.pow(2,-s))<1&&(s--,u*=2),(e+=s+l>=1?h/u:h*Math.pow(2,1-l))*u>=2&&(s++,u/=2),s+l>=f?(a=0,s=f):s+l>=1?(a=(e*u-1)*Math.pow(2,i),s+=l):(a=e*Math.pow(2,l-1)*Math.pow(2,i),s=0));i>=8;t[n+p]=255&a,p+=d,a/=256,i-=8);for(s=s<<i|a,c+=i;c>0;t[n+p]=255&s,p+=d,s/=256,c-=8);t[n+p-d]|=128*y;}function Qt(){return Gt.TYPED_ARRAY_SUPPORT?2147483647:1073741823}function Jt(t,e){if(Qt()<e)throw new RangeError("Invalid typed array length");return Gt.TYPED_ARRAY_SUPPORT?(t=new Uint8Array(e)).__proto__=Gt.prototype:(null===t&&(t=new Gt(e)),t.length=e),t}function Gt(t,e,n){if(!(Gt.TYPED_ARRAY_SUPPORT||this instanceof Gt))return new Gt(t,e,n);if("number"==typeof t){if("string"==typeof e)throw new Error("If encoding is specified then the first argument must be a string");return ee(this,t)}return Xt(this,t,e,n)}function Xt(t,e,n,r){if("number"==typeof e)throw new TypeError('"value" argument must not be a number');return"undefined"!=typeof ArrayBuffer&&e instanceof ArrayBuffer?ie(t,e,n,r):"string"==typeof e?ne(t,e,n):oe(t,e)}function Zt(t){if("number"!=typeof t)throw new TypeError('"size" argument must be a number');if(t<0)throw new RangeError('"size" argument must not be negative')}function te(t,e,n,r){return Zt(e),e<=0?Jt(t,e):void 0!==n?"string"==typeof r?Jt(t,e).fill(n,r):Jt(t,e).fill(n):Jt(t,e)}function ee(t,e){if(Zt(e),t=Jt(t,e<0?0:0|se(e)),!Gt.TYPED_ARRAY_SUPPORT)for(var n=0;n<e;++n)t[n]=0;return t}function ne(t,e,n){if("string"==typeof n&&""!==n||(n="utf8"),!Gt.isEncoding(n))throw new TypeError('"encoding" must be a valid string encoding');var r=0|ue(e,n),i=(t=Jt(t,r)).write(e,n);return i!==r&&(t=t.slice(0,i)),t}function re(t,e){var n=e.length<0?0:0|se(e.length);t=Jt(t,n);for(var r=0;r<n;r+=1)t[r]=255&e[r];return t}function ie(t,e,n,r){if(e.byteLength,n<0||e.byteLength<n)throw new RangeError("'offset' is out of bounds");if(e.byteLength<n+(r||0))throw new RangeError("'length' is out of bounds");return e=void 0===n&&void 0===r?new Uint8Array(e):void 0===r?new Uint8Array(e,n):new Uint8Array(e,n,r),Gt.TYPED_ARRAY_SUPPORT?(t=e).__proto__=Gt.prototype:t=re(t,e),t}function oe(t,e){if(ae(e)){var n=0|se(e.length);return 0===(t=Jt(t,n)).length?t:(e.copy(t,0,0,n),t)}if(e){if("undefined"!=typeof ArrayBuffer&&e.buffer instanceof ArrayBuffer||"length"in e)return"number"!=typeof e.length||ze(e.length)?Jt(t,0):re(t,e);if("Buffer"===e.type&&Zo(e.data))return re(t,e.data)}throw new TypeError("First argument must be a string, Buffer, ArrayBuffer, Array, or array-like object.")}function se(t){if(t>=Qt())throw new RangeError("Attempt to allocate Buffer larger than maximum size: 0x"+Qt().toString(16)+" bytes");return 0|t}function ae(t){return!(null==t||!t._isBuffer)}function ue(t,e){if(ae(t))return t.length;if("undefined"!=typeof ArrayBuffer&&"function"==typeof ArrayBuffer.isView&&(ArrayBuffer.isView(t)||t instanceof ArrayBuffer))return t.byteLength;"string"!=typeof t&&(t=""+t);var n=t.length;if(0===n)return 0;for(var r=!1;;)switch(e){case"ascii":case"latin1":case"binary":return n;case"utf8":case"utf-8":case void 0:return Be(t).length;case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return 2*n;case"hex":return n>>>1;case"base64":return Ne(t).length;default:if(r)return Be(t).length;e=(""+e).toLowerCase(),r=!0;}}function ce(t,e,n){var r=!1;if((void 0===e||e<0)&&(e=0),e>this.length)return"";if((void 0===n||n>this.length)&&(n=this.length),n<=0)return"";if(n>>>=0,e>>>=0,n<=e)return"";for(t||(t="utf8");;)switch(t){case"hex":return Ae(this,e,n);case"utf8":case"utf-8":return _e(this,e,n);case"ascii":return Ee(this,e,n);case"latin1":case"binary":return xe(this,e,n);case"base64":return be(this,e,n);case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return Fe(this,e,n);default:if(r)throw new TypeError("Unknown encoding: "+t);t=(t+"").toLowerCase(),r=!0;}}function fe(t,e,n){var r=t[e];t[e]=t[n],t[n]=r;}function le(t,e,n,r,i){if(0===t.length)return-1;if("string"==typeof n?(r=n,n=0):n>2147483647?n=2147483647:n<-2147483648&&(n=-2147483648),n=+n,isNaN(n)&&(n=i?0:t.length-1),n<0&&(n=t.length+n),n>=t.length){if(i)return-1;n=t.length-1;}else if(n<0){if(!i)return-1;n=0;}if("string"==typeof e&&(e=Gt.from(e,r)),ae(e))return 0===e.length?-1:he(t,e,n,r,i);if("number"==typeof e)return e&=255,Gt.TYPED_ARRAY_SUPPORT&&"function"==typeof Uint8Array.prototype.indexOf?i?Uint8Array.prototype.indexOf.call(t,e,n):Uint8Array.prototype.lastIndexOf.call(t,e,n):he(t,[e],n,r,i);throw new TypeError("val must be string, number or Buffer")}function he(t,e,n,r,i){function o(t,e){return 1===s?t[e]:t.readUInt16BE(e*s)}var s=1,a=t.length,u=e.length;if(void 0!==r&&("ucs2"===(r=String(r).toLowerCase())||"ucs-2"===r||"utf16le"===r||"utf-16le"===r)){if(t.length<2||e.length<2)return-1;s=2,a/=2,u/=2,n/=2;}var c;if(i){var f=-1;for(c=n;c<a;c++)if(o(t,c)===o(e,-1===f?0:c-f)){if(-1===f&&(f=c),c-f+1===u)return f*s}else-1!==f&&(c-=c-f),f=-1;}else for(n+u>a&&(n=a-u),c=n;c>=0;c--){for(var l=!0,h=0;h<u;h++)if(o(t,c+h)!==o(e,h)){l=!1;break}if(l)return c}return-1}function pe(t,e,n,r){n=Number(n)||0;var i=t.length-n;r?(r=Number(r))>i&&(r=i):r=i;var o=e.length;if(o%2!=0)throw new TypeError("Invalid hex string");r>o/2&&(r=o/2);for(var s=0;s<r;++s){var a=parseInt(e.substr(2*s,2),16);if(isNaN(a))return s;t[n+s]=a;}return s}function de(t,e,n,r){return Ue(Be(e,t.length-n),t,n,r)}function ye(t,e,n,r){return Ue(Ie(e),t,n,r)}function ge(t,e,n,r){return ye(t,e,n,r)}function ve(t,e,n,r){return Ue(Ne(e),t,n,r)}function me(t,e,n,r){return Ue(Le(e,t.length-n),t,n,r)}function be(t,e,n){return Wt(0===e&&n===t.length?t:t.slice(e,n))}function _e(t,e,n){n=Math.min(t.length,n);for(var r=[],i=e;i<n;){var o=t[i],s=null,a=o>239?4:o>223?3:o>191?2:1;if(i+a<=n){var u,c,f,l;switch(a){case 1:o<128&&(s=o);break;case 2:128==(192&(u=t[i+1]))&&(l=(31&o)<<6|63&u)>127&&(s=l);break;case 3:u=t[i+1],c=t[i+2],128==(192&u)&&128==(192&c)&&(l=(15&o)<<12|(63&u)<<6|63&c)>2047&&(l<55296||l>57343)&&(s=l);break;case 4:u=t[i+1],c=t[i+2],f=t[i+3],128==(192&u)&&128==(192&c)&&128==(192&f)&&(l=(15&o)<<18|(63&u)<<12|(63&c)<<6|63&f)>65535&&l<1114112&&(s=l);}}null===s?(s=65533,a=1):s>65535&&(s-=65536,r.push(s>>>10&1023|55296),s=56320|1023&s),r.push(s),i+=a;}return we(r)}function we(t){var e=t.length;if(e<=es)return String.fromCharCode.apply(String,t);for(var n="",r=0;r<e;)n+=String.fromCharCode.apply(String,t.slice(r,r+=es));return n}function Ee(t,e,n){var r="";n=Math.min(t.length,n);for(var i=e;i<n;++i)r+=String.fromCharCode(127&t[i]);return r}function xe(t,e,n){var r="";n=Math.min(t.length,n);for(var i=e;i<n;++i)r+=String.fromCharCode(t[i]);return r}function Ae(t,e,n){var r=t.length;(!e||e<0)&&(e=0),(!n||n<0||n>r)&&(n=r);for(var i="",o=e;o<n;++o)i+=Re(t[o]);return i}function Fe(t,e,n){for(var r=t.slice(e,n),i="",o=0;o<r.length;o+=2)i+=String.fromCharCode(r[o]+256*r[o+1]);return i}function je(t,e,n){if(t%1!=0||t<0)throw new RangeError("offset is not uint");if(t+e>n)throw new RangeError("Trying to access beyond buffer length")}function ke(t,e,n,r,i,o){if(!ae(t))throw new TypeError('"buffer" argument must be a Buffer instance');if(e>i||e<o)throw new RangeError('"value" argument is out of bounds');if(n+r>t.length)throw new RangeError("Index out of range")}function Ce(t,e,n,r){e<0&&(e=65535+e+1);for(var i=0,o=Math.min(t.length-n,2);i<o;++i)t[n+i]=(e&255<<8*(r?i:1-i))>>>8*(r?i:1-i);}function Se(t,e,n,r){e<0&&(e=4294967295+e+1);for(var i=0,o=Math.min(t.length-n,4);i<o;++i)t[n+i]=e>>>8*(r?i:3-i)&255;}function Te(t,e,n,r,i,o){if(n+r>t.length)throw new RangeError("Index out of range");if(n<0)throw new RangeError("Index out of range")}function Oe(t,e,n,r,i){return i||Te(t,e,n,4,3.4028234663852886e38,-3.4028234663852886e38),Kt(t,e,n,r,23,4),n+4}function Pe(t,e,n,r,i){return i||Te(t,e,n,8,1.7976931348623157e308,-1.7976931348623157e308),Kt(t,e,n,r,52,8),n+8}function De(t){if((t=Me(t).replace(ns,"")).length<2)return"";for(;t.length%4!=0;)t+="=";return t}function Me(t){return t.trim?t.trim():t.replace(/^\s+|\s+$/g,"")}function Re(t){return t<16?"0"+t.toString(16):t.toString(16)}function Be(t,e){e=e||1/0;for(var n,r=t.length,i=null,o=[],s=0;s<r;++s){if((n=t.charCodeAt(s))>55295&&n<57344){if(!i){if(n>56319){(e-=3)>-1&&o.push(239,191,189);continue}if(s+1===r){(e-=3)>-1&&o.push(239,191,189);continue}i=n;continue}if(n<56320){(e-=3)>-1&&o.push(239,191,189),i=n;continue}n=65536+(i-55296<<10|n-56320);}else i&&(e-=3)>-1&&o.push(239,191,189);if(i=null,n<128){if((e-=1)<0)break;o.push(n);}else if(n<2048){if((e-=2)<0)break;o.push(n>>6|192,63&n|128);}else if(n<65536){if((e-=3)<0)break;o.push(n>>12|224,n>>6&63|128,63&n|128);}else{if(!(n<1114112))throw new Error("Invalid code point");if((e-=4)<0)break;o.push(n>>18|240,n>>12&63|128,n>>6&63|128,63&n|128);}}return o}function Ie(t){for(var e=[],n=0;n<t.length;++n)e.push(255&t.charCodeAt(n));return e}function Le(t,e){for(var n,r,i,o=[],s=0;s<t.length&&!((e-=2)<0);++s)r=(n=t.charCodeAt(s))>>8,i=n%256,o.push(i),o.push(r);return o}function Ne(t){return Ht(De(t))}function Ue(t,e,n,r){for(var i=0;i<r&&!(i+n>=e.length||i>=t.length);++i)e[i+n]=t[i];return i}function ze(t){return t!==t}function qe(t){return null!=t&&(!!t._isBuffer||He(t)||$e(t))}function He(t){return!!t.constructor&&"function"==typeof t.constructor.isBuffer&&t.constructor.isBuffer(t)}function $e(t){return"function"==typeof t.readFloatLE&&"function"==typeof t.slice&&He(t.slice(0,0))}function Ye(t,e){this.index=t,this.values=e;}function We(t,e){this.index=t,this.howMany=e;}function Ve(t,e,n){this.from=t,this.to=e,this.howMany=n;}function Ke(t,e){return t===e}function Qe(t,e,n){n||(n=Ke);for(var r=t.length,i=e.length,o=[],s={},a={},u=0;u<r;u++)for(var c=t[u],f=0;f<i;f++)if(!a[f]&&n(c,e[f],u,f)){var l=u,h=f,p=0;do{s[u++]=a[f++]=!0,p++;}while(u<r&&f<i&&n(t[u],e[f],u,f)&&!a[f]);o.push(new Ve(l,h,p)),u--;break}var d=[];for(u=0;u<r;)if(s[u])u++;else{for(var y=u,p=0;u<r&&!s[u++];)p++;d.push(new We(y,p));}var g=[];for(f=0;f<i;)if(a[f])f++;else{for(var y=f,p=0;f<i&&!a[f++];)p++;var v=e.slice(y,y+p);g.push(new Ye(y,v));}var m,b,_=g.length,w=d.length,E=o.length,x=0;for(m=0;m<w;m++){var A=d[m];for(A.index-=x,x+=A.howMany,b=0;b<E;b++)(C=o[b]).from>=A.index&&(C.from-=A.howMany);}for(m=_;m--;){var F=g[m],p=F.values.length;for(b=E;b--;)(C=o[b]).to>=F.index&&(C.to-=p);}for(m=E;m-- >1;)if((C=o[m]).to!==C.from)for(b=m;b--;){var j=o[b];j.to>=C.to&&(j.to-=C.howMany),j.to>=C.from&&(j.to+=C.howMany);}var k=[];for(m=0;m<E;m++){var C=o[m];if(C.to!==C.from)for(k.push(C),b=m+1;b<E;b++){var S=o[b];S.from>=C.from&&(S.from-=C.howMany),S.from>=C.to&&(S.from+=C.howMany);}}return d.concat(k,g)}function Je(t){for(var e=1;e<arguments.length;e+=1){var n=arguments[e];Object.keys(n).forEach(function(e){t[e]=n[e];});}return t}function Ge(t){var e=0,n=0,r=0;for(var i in t){var o=t[i],s=o[0],a=o[1];(s>n||s===n&&a>r)&&(n=s,r=a,e=+i);}return e}function Xe(t,e){this.index=t,this.values=e;}function Ze(t,e){this.index=t,this.howMany=e;}function tn(t,e,n){this.from=t,this.to=e,this.howMany=n;}function en(t,e,n,r,i){return i(t===e)}function nn(t,e,n,r){function i(r,o,u,l){c[r++]=f[o++]=!0,u++,r<s&&o<a&&!f[o]?n(t[r],e[o],r,o,function(t){t?setTimeout(function(){i(r,o,u,l);},0):l(r,o,u);}):l(r,o,u);}function o(r,c,l,h){c>=a&&(r++,c=0),r>=s?h():f[c]?l?o(r,c+1,l-1,h):setTimeout(function(){o(r,c+1,ys,h);},0):n(t[r],e[c],r,c,function(t){if(t){var e=r,n=c;i(r,c,0,function(t,r,i){u.push(new tn(e,n,i)),l?o(t,0,l-1,h):setTimeout(function(){o(t,0,ys,h);},0);});}else l?o(r,c+1,l-1,h):setTimeout(function(){o(r,c+1,ys,h);},0);});}n||(n=en);var s=t.length,a=e.length,u=[],c={},f={};o(0,0,ys,function(){for(var t=[],n=0;n<s;)if(c[n])n++;else{for(var i=n,o=0;n<s&&!c[n++];)o++;t.push(new Ze(i,o));}for(var l=[],h=0;h<a;)if(f[h])h++;else{for(var i=h,o=0;h<a&&!f[h++];)o++;var p=e.slice(i,i+o);l.push(new Xe(i,p));}var d,y,g=l.length,v=t.length,m=u.length,b=0;for(d=0;d<v;d++){var _=t[d];for(_.index-=b,b+=_.howMany,y=0;y<m;y++)(A=u[y]).from>=_.index&&(A.from-=_.howMany);}for(d=g;d--;){var w=l[d],o=w.values.length;for(y=m;y--;)(A=u[y]).to>=w.index&&(A.to-=o);}for(d=m;d-- >1;)if((A=u[d]).to!==A.from)for(y=d;y--;){var E=u[y];E.to>=A.to&&(E.to-=A.howMany),E.to>=A.from&&(E.to+=A.howMany);}var x=[];for(d=0;d<m;d++){var A=u[d];if(A.to!==A.from)for(x.push(A),y=d+1;y<m;y++){var F=u[y];F.from>=A.from&&(F.from-=A.howMany),F.from>=A.to&&(F.from+=A.howMany);}}r(t.concat(x,l));});}function rn(t){for(var e=1;e<arguments.length;e+=1){var n=arguments[e];Object.keys(n).forEach(function(e){t[e]=n[e];});}return t}var on="undefined"!=typeof window?window:"undefined"!=typeof commonjsGlobal?commonjsGlobal:"undefined"!=typeof self?self:{},sn=function(t){this.text=t;},an="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},un=function(t,e,n,r,i){i=i||{};var o=t.clone();e&&e.call(o,o);var s=t.clone();if("function"==typeof r)r.call(s,s);else if(r.length>0){var a=!1;r.forEach(function(t,e){var n=t&&"object"===(void 0===t?"undefined":an(t))&&t instanceof sn;0<e&&(n||a||s.text(","),s.sp()),n?s.error(t.text):t.call(s,s),a=n;});}var u=o.size(),c=s.size(),f="expected".length+u.width+c.width+n.length,l=Math.max(u.height,c.height);if("omitSubject"in t&&t.omitSubject===i.subject){var h=/^(not )?to (.*)/.exec(n);h?(t.error("should "),h[1]&&t.error("not "),n=h[2]):n="expected: "+n;}else i.compact&&i.compactSubject&&(u.height>1||u.width>(i.compactWidth||35))?(t.error("expected").sp(),i.compactSubject.call(t,t),t.sp()):(t.error("expected"),u.height>1?t.nl():t.sp(),t.append(o),u.height>1||1===l&&f>t.preferredWidth?t.nl():t.sp());return t.error(n),c.height>1?t.nl():c.width>0&&t.sp(),t.append(s),t},cn={intersects:function(t,e){return t.start<e.end&&e.start<t.end||t.start===e.start},intersectsWithSome:function(t,e){return t.some(function(t){return cn.intersects(e,t)})}},fn=cn,ln=function(t,e){var n=e.start-t.start;return 0!==n?n:t.end-t.start-(e.end-e.start)},hn=fn.intersectsWithSome,pn=function(t,e){if(e=e||{},!Array.isArray(t))throw new Error("The interval packer requires an array of objects with start and end properties.");if(0===t.length)return[];t.forEach(function(t){if("object"!=typeof t||"number"!=typeof t.start||"number"!=typeof t.end||t.end<=t.start)throw new Error("Intervals must be objects with integer properties start and end where start < end.")}),t=[].concat(t).sort(ln);for(var n,r=[],i=-1/0;t.length>0;){var o=t.pop();i<=o.start&&(n=[[]],r.push(n));for(var s=0;s<n.length&&hn(n[s],o);)s+=1;(n[s]=n[s]||[]).push(o),i=Math.max(i,o.end);}return e.groupPartitions?r:r.reduce(function(t,e){return e.forEach(function(e,n){return t[n]=t[n]||[],Array.prototype.push.apply(t[n],e),t}),t},[])},dn=t(function(t){var e="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},n=Object.setPrototypeOf||{__proto__:[]}instanceof Array,r=Object.setPrototypeOf||function(t,e){return t.__proto__=e,t},i=t.exports={objectIs:Object.is||function(t,e){return 0===t&&0===e?1/t==1/e:t!==t?e!==e:t===e},isArray:function(t){return"[object Array]"===Object.prototype.toString.call(t)},isRegExp:function(t){return"[object RegExp]"===Object.prototype.toString.call(t)},isError:function(t){return"object"===(void 0===t?"undefined":e(t))&&("[object Error]"===Object.prototype.toString.call(t)||t instanceof Error)},extend:function(t){for(var e=1;e<arguments.length;e+=1){var n=arguments[e];n&&Object.keys(n).forEach(function(e){t[e]=n[e];});}return t},findFirst:function(t,e){for(var n=0;n<t.length;n+=1)if(e(t[n]))return t[n];return null},leftPad:function(t,e,n){for(n=n||" ";t.length<e;)t=n+t;return t},escapeRegExpMetaChars:function(t){return t.replace(/[[\]{}()*+?.\\^$|]/g,"\\$&")},escapeChar:function(t){if("\t"===t)return"\\t";if("\r"===t)return"\\r";var e=t.charCodeAt(0),n=e.toString(16).toUpperCase();return e<256?"\\x"+i.leftPad(n,2,"0"):"\\u"+i.leftPad(n,4,"0")},getFunctionName:function(t){if("string"==typeof t.name)return t.name;var e=Function.prototype.toString.call(t).match(/function ([^\(]+)/);return e?e[1]:t===Object?"Object":t===Function?"Function":""},wrapConstructorNameAroundOutput:function(t,e){var n=e.constructor,r=n&&n!==Object&&i.getFunctionName(n);return r&&"Object"!==r?t.clone().text(r+"(").append(t).text(")"):t},setPrototypeOfOrExtend:n?r:function(t,e){for(var n in e)e.hasOwnProperty(n)&&(t[n]=e[n]);return t},uniqueStringsAndSymbols:function(){function t(i){Array.isArray(i)?i.forEach(t):Object.prototype.hasOwnProperty.call(n,i)||e&&!e(i)||(n[i]=!0,r.push(i));}var e;"function"==typeof arguments[0]&&(e=arguments[0]);for(var n={},r=[],i=e?1:0;i<arguments.length;i+=1)t(arguments[i]);return r},uniqueNonNumericalStringsAndSymbols:function(){return i.uniqueStringsAndSymbols(function(t){return"symbol"===(void 0===t?"undefined":e(t))||!i.numericalRegExp.test(t)},Array.prototype.slice.call(arguments))},forwardFlags:function(t,e){return t.replace(/\[(!?)([^\]]+)\] ?/g,function(t,n,r){return Boolean(e[r])!==Boolean(n)?r+" ":""}).trim()},numericalRegExp:/^(?:0|[1-9][0-9]*)$/,packArrows:function(t){var e={};t.forEach(function(t,n){"moveSource"===t.type?(t.changeIndex=n,(e[t.actualIndex]=e[t.actualIndex]||{}).source=t):"moveTarget"===t.type&&(t.changeIndex=n,(e[t.actualIndex]=e[t.actualIndex]||{}).target=t);});var n=Object.keys(e);if(n.length>0){var r=[];n.sort(function(t,n){return Math.abs(e[n].source.changeIndex-e[n].target.changeIndex)-Math.abs(e[t].source.changeIndex-e[t].target.changeIndex)}).forEach(function(t,n,i){var o=e[t],s=Math.min(o.source.changeIndex,o.target.changeIndex),a=Math.max(o.source.changeIndex,o.target.changeIndex);r.push({start:s,end:a,direction:o.source.changeIndex<o.target.changeIndex?"down":"up"});});for(var i=pn(r);i.length>3;)i.shift().forEach(function(e){t["up"===e.direction?e.start:e.end].type="insert",t["up"===e.direction?e.end:e.start].type="remove";});return i}}};}),yn="undefined"!=typeof commonjsGlobal?commonjsGlobal:"undefined"!=typeof self?self:"undefined"!=typeof window?window:{},gn=e,vn=n;"function"==typeof yn.setTimeout&&(gn=setTimeout),"function"==typeof yn.clearTimeout&&(vn=clearTimeout);var mn=[],bn=!1,_n,wn=-1;u.prototype.run=function(){this.fun.apply(null,this.array);};for(var En="browser",xn="browser",An=!0,Fn={},jn=[],kn="",Cn={},Sn={},Tn={},On=c,Pn=c,Dn=c,Mn=c,Rn=c,Bn=c,In=c,Ln=yn.performance||{},Nn=Ln.now||Ln.mozNow||Ln.msNow||Ln.oNow||Ln.webkitNow||function(){return(new Date).getTime()},Un=new Date,zn={nextTick:a,title:En,browser:An,env:Fn,argv:jn,version:kn,versions:Cn,on:On,addListener:Pn,once:Dn,off:Mn,removeListener:Rn,removeAllListeners:Bn,emit:In,binding:f,cwd:l,chdir:h,umask:p,hrtime:d,platform:xn,release:Sn,config:Tn,uptime:y},qn=!0,Hn={extend:function(t){for(var e=1;e<arguments.length;e+=1){var n=arguments[e];Object.keys(n).forEach(function(e){t[e]=n[e];});}return t},calculateOutputEntrySize:function(t){if(t.size)return t.size;var e;switch(t.style){case"text":e={width:String(t.args.content).length,height:1};break;case"block":e=Hn.calculateSize(t.args);break;case"raw":var n=t.args;e={width:n.width,height:n.height};break;default:e={width:0,height:0};}return t.size=e,e},calculateLineSize:function(t){var e={height:1,width:0};return t.forEach(function(t){var n=Hn.calculateOutputEntrySize(t);e.width+=n.width,e.height=Math.max(n.height,e.height);}),e},calculateSize:function(t){var e={height:0,width:0};return t.forEach(function(t){var n=Hn.calculateLineSize(t);e.height+=n.height,e.width=Math.max(e.width,n.width);}),e},arrayEquals:function(t,e){if(t===e)return!0;if(!t||t.length!==e.length)return!1;for(var n=0;n<t.length;n+=1)if(t[n]!==e[n])return!1;return!0},escapeRegExp:function(t){return t.replace(/([.*+?^${}()|\[\]\/\\])/g,"\\$1")},findFirst:function(t,e,n){for(var r=n||null,i=0;i<t.length;i+=1)if(e.call(r,t[i],i,t))return t[i];return null},getFunctionName:function(t){if("string"==typeof t.name)return t.name;var e=Function.prototype.toString.call(t).match(/function ([^\(]+)/);return e?e[1]:t===Object?"Object":t===Function?"Function":void 0}},$n=Hn,Yn=256,Wn=[""],Vn=1;Vn<=Yn;Vn+=1)Wn[Vn]=Wn[Vn-1]+" ";var Kn=g,Qn=/^(?:bg)?#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i,Jn={bold:"font-weight: bold",dim:"opacity: 0.7",italic:"font-style: italic",underline:"text-decoration: underline",inverse:"-webkit-filter: invert(%100); filter: invert(100%)",hidden:"visibility: hidden",strikeThrough:"text-decoration: line-through",black:"color: black",red:"color: red",green:"color: green",yellow:"color: yellow",blue:"color: blue",magenta:"color: magenta",cyan:"color: cyan",white:"color: white",gray:"color: gray",bgBlack:"background-color: black",bgRed:"background-color: red",bgGreen:"background-color: green",bgYellow:"background-color: yellow",bgBlue:"background-color: blue",bgMagenta:"background-color: magenta",bgCyan:"background-color: cyan",bgWhite:"background-color: white"};Object.keys(Jn).forEach(function(t){Jn[t.toLowerCase()]=Jn[t];});var Gn=Jn,Xn=zn.argv,Zn=-1===Xn.indexOf("--no-color")&&-1===Xn.indexOf("--no-colors")&&-1===Xn.indexOf("--color=false")&&(-1!==Xn.indexOf("--color")||-1!==Xn.indexOf("--colors")||-1!==Xn.indexOf("--color=true")||-1!==Xn.indexOf("--color=always")||!(zn.stdout&&!zn.stdout.isTTY)&&("win32"===zn.platform||("COLORTERM"in zn.env||"dumb"!==zn.env.TERM&&!!/^screen|^xterm|^vt100|color|ansi|cygwin|linux/i.test(zn.env.TERM)))),tr=w;E.prototype.format="text",E.prototype.serialize=function(t){return(t=tr(t)).map(this.serializeLine,this).join("\n")},E.prototype.serializeLine=function(t){return t.map(function(t){return this[t.style]?String(this[t.style](t.args)):""},this).join("")},E.prototype.text=function(t){return String(t.content)},E.prototype.block=function(t){return this.serialize(t)},E.prototype.raw=function(t){return String(t.content(this))};var er=E,nr=function(t,e){if(1===e.length){for(var n=0,r=[],i=e[0],o=t.styles||{};"string"==typeof i&&o[i];)if(i=o[i],100<(n+=1)){var s=r.indexOf(i);if(r.push(i),-1!==s)throw new Error("Your theme contains a loop: "+r.slice(s).join(" -> "))}return Array.isArray(i)?i:[i]}return e};x.prototype.format="html",x.prototype.serialize=function(t){return'<div style="font-family: monospace; white-space: nowrap">'+this.serializeLines(t)+"</div>"},x.prototype.serializeLines=function(t){return t.map(function(t){return"<div>"+(this.serializeLine(t).join("")||"&nbsp;")+"</div>"},this).join("")},x.prototype.serializeLine=function(t){return t.map(function(t){return this[t.style]?this[t.style](t.args):""},this)},x.prototype.block=function(t){return'<div style="display: inline-block; vertical-align: top">'+this.serializeLines(t)+"</div>"},x.prototype.text=function(t){var e=String(t.content);if(""===e)return"";e=e.replace(/&/g,"&amp;").replace(/ /g,"&nbsp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");var n=nr(this.theme,t.styles);if(n.length>0){for(var r=[],i=0;i<n.length;i+=1){var o=n[i];Qn.test(o)?"bg"===o.substring(0,2)?r.push("background-color: "+o.substring(2)):r.push("color: "+o):Gn[o]&&r.push(Gn[o]);}r.length>0&&(e='<span style="'+r.join("; ")+'">'+e+"</span>");}return e},x.prototype.raw=function(t){return String(t.content(this))};var rr=x,ir=A,or=Math.sqrt,sr=Math.pow,ar=Math.cos,ur=Math.atan2,cr=Math.sin,fr=Math.abs,lr=Math.exp,hr=Math.PI,pr={ciede2000:ir},dr=k,yr=Math.pow,gr={rgb_to_lab:dr},vr=O,mr=T,br={map_palette:vr,palette_map_key:mr},_r=t(function(t){var e=t.exports={};e.diff=pr.ciede2000,e.rgb_to_lab=gr.rgb_to_lab,e.map_palette=br.map_palette,e.palette_map_key=br.palette_map_key,e.closest=function(t,n){var r=e.palette_map_key(t);return e.map_palette([t],n,"closest")[r]},e.furthest=function(t,n){var r=e.palette_map_key(t);return e.map_palette([t],n,"furthest")[r]};}),wr=t(function(t){var e=t.exports={modifiers:{reset:[0,0],bold:[1,22],dim:[2,22],italic:[3,23],underline:[4,24],inverse:[7,27],hidden:[8,28],strikethrough:[9,29]},colors:{black:[30,39],red:[31,39],green:[32,39],yellow:[33,39],blue:[34,39],magenta:[35,39],cyan:[36,39],white:[37,39],gray:[90,39]},bgColors:{bgBlack:[40,49],bgRed:[41,49],bgGreen:[42,49],bgYellow:[43,49],bgBlue:[44,49],bgMagenta:[45,49],bgCyan:[46,49],bgWhite:[47,49]}};e.colors.grey=e.colors.gray,Object.keys(e).forEach(function(t){var n=e[t];Object.keys(n).forEach(function(t){var r=n[t];e[t]=n[t]={open:"["+r[0]+"m",close:"["+r[1]+"m"};}),Object.defineProperty(e,t,{value:n,enumerable:!1});});}),Er=0,xr=1024,Ar=$n.extend({},wr);Object.keys(Ar).forEach(function(t){Ar[t.toLowerCase()]=Ar[t];}),D.prototype=new er,D.prototype.format="ansi";var Fr={16:{"#000000":"black","#ff0000":"red","#00ff00":"green","#ffff00":"yellow","#0000ff":"blue","#ff00ff":"magenta","#00ffff":"cyan","#ffffff":"white","#808080":"gray"},256:{}},jr={};jr[16]=Object.keys(Fr[16]).map(M),jr.bg16=Object.keys(Fr[16]).filter(function(t){return"#808080"!==t}).map(M),jr[256]=[].concat(jr[16]);for(var kr=16,Cr=0;Cr<6;Cr+=1)for(var Sr=0;Sr<6;Sr+=1)for(var Tr=0;Tr<6;Tr+=1)I({R:Math.round(256*Cr/6),G:Math.round(256*Sr/6),B:Math.round(256*Tr/6)});[8,18,28,38,48,58,68,78,88,96,102,118,128,138,148,158,168,178,188,198,208,218,228,238].forEach(function(t){I({R:t,G:t,B:t});}),D.prototype.text=function(t){var e=String(t.content);if(""===e)return"";var n=nr(this.theme,t.styles);if(n.length>0)for(var r=n.length-1;r>=0;r-=1){var i=n[r];if(Ar[i])e=Ar[i].open+e+Ar[i].close;else if(Qn.test(i)){var o=i,s="bg"===i.substring(0,2),a=s?i.substring(2):i,u=R(_r.closest(M(a),jr[s?"bg16":16])),c=Fr[16][u],f=R(_r.closest(M(a),jr[256])),l=Fr[256][f];i=s?"bg"+B(c):c;var h=Ar[i].open,p=Ar[i].close;u!==f&&(h+="["+(s?48:38)+";5;"+l+"m"),Er<xr&&(Ar[o]={open:h,close:p},Er+=1),e=h+e+p;}}return e};var Or=D;L.prototype.format="coloredConsole",L.prototype.serialize=function(t){var e="",n=[];return this.serializeLines(tr(t)).forEach(function(t){t&&(e+=t[0],t.length>1&&n.push(t[1]));}),[e].concat(n)},L.prototype.serializeLines=function(t){var e=[];return t.forEach(function(t,n){n>0&&e.push(["%c\n ",""]),Array.prototype.push.apply(e,this.serializeLine(t));},this),e},L.prototype.serializeLine=function(t){var e=[];return t.forEach(function(t){this[t.style]&&e.push(this[t.style](t.args));},this),e},L.prototype.block=function(t){return this.serializeLines(t)},L.prototype.text=function(t){var e=String(t.content);if(""===e)return"";var n=nr(this.theme,t.styles),r=["%c"+e.replace(/%/g,"%%")],i=[];if(n.length>0)for(var o=0;o<n.length;o+=1){var s=n[o];Qn.test(s)?"bg"===s.substring(0,2)?i.push("background-color: "+s.substring(2)):i.push("color: "+s):Gn[s]&&i.push(Gn[s]);}return r.push(i.join("; ")),r},L.prototype.raw=function(t){return String(t.content(this))};var Pr=L,Dr=t(function(t,e){function n(t){if(!(this instanceof n))return new n(t);"string"==typeof(t=t||{})&&(t={format:t});var e="indentationWidth"in t?t.indentationWidth:2;this.indentationWidth=Math.max(e,0),this.indentationLevel=0,this.output=[[]],this.styles=Object.create(null),this.installedPlugins=[],this._themes={},Object.keys(n.serializers).forEach(function(t){this._themes[t]={styles:{}};},this),this.preferredWidth=!qn&&zn.stdout.columns||80,t.format&&(this.format=t.format);}function r(t,e){return!(!t||!e||"text"!==t.style||"text"!==e.style)&&$n.arrayEquals(t.args.styles,e.args.styles)}function i(t){if(0===t.length)return t;for(var e=[t[0]],n=1;n<t.length;n+=1){var i=e[e.length-1],o=t[n];"text"===o.style&&""===o.args.content||(r(i,o)?e[e.length-1]={style:i.style,args:{content:i.args.content+o.args.content,styles:i.args.styles}}:e.push(o));}return e}function o(t){return t&&"object"==typeof t&&"number"==typeof t.width&&"number"==typeof t.height&&("function"==typeof t.content||"string"==typeof t.content)}function s(t,e){var n=t[t.length-1].slice(),r=t.slice(0,-1),o=n[n.length-1];return o&&"block"===o.style?(n[n.length-1]={style:"block",args:s(o.args,e)},r[t.length-1]=n):(Array.prototype.push.apply(n,e.output[0]),r[t.length-1]=i(n),r.push.apply(r,e.output.slice(1))),r}function a(t,e,n,r){var o=t;return e.forEach(function(e,i){0<i&&o.nl(),e.forEach(function(e,i){if("block"===e.style)return o.output[o.output.length-1].push({style:"block",args:a(t.clone(),e.args,n,r)});if("text"!==e.style)return o.output[o.output.length-1].push(e);n.global&&(n.lastIndex=0);for(var s,u=!0,c=0,f=e.args.content,l=e.args.styles;null!==(s=n.exec(f))&&(n.global||u);)c<s.index&&o.text.apply(o,[f.substring(c,s.index)].concat(l)),r.apply(o,[l].concat(s)),u=!1,c=s.index+s[0].length;if(0===c){(0===o.output.length?o.output[0]=[]:o.output[o.output.length-1]).push(e);}else c<f.length&&o.text.apply(o,[f.substring(c,f.length)].concat(l));},this);},this),o.output.map(i)}var u=$n.extend,c=["bold","dim","italic","underline","inverse","hidden","strikeThrough","black","red","green","yellow","blue","magenta","cyan","white","gray","bgBlack","bgRed","bgGreen","bgYellow","bgBlue","bgMagenta","bgCyan","bgWhite"];"string"!=typeof e.nodeName&&Zn?n.defaultFormat="ansi":"undefined"!=typeof window&&void 0!==window.navigator?window._phantom||window.mochaPhantomJS||window.__karma__&&window.__karma__.config.captureConsole?n.defaultFormat="ansi":n.defaultFormat="html":n.defaultFormat="text",n.prototype.newline=n.prototype.nl=function(t){if(void 0===t&&(t=1),0===t)return this;for(var e=0;e<t;e+=1)this.output.push([]);return this},n.serializers={},[er,rr,Or,Pr].forEach(function(t){n.serializers[t.prototype.format]=t;}),n.prototype.write=function(t){if(this.styles[t.style])return this.styles[t.style].apply(this,t.args),this;var e=this.output[this.output.length-1],n=e[e.length-1];return r(n,t)?e[e.length-1]={style:n.style,args:{content:n.args.content+t.args.content,styles:n.args.styles}}:e.push(t),this},n.prototype.indentLines=function(){return this.indentationLevel+=1,this},n.prototype.indent=n.prototype.i=function(){for(var t=0;t<this.indentationLevel;t+=1)this.space(this.indentationWidth);return this},n.prototype.outdentLines=function(){return this.indentationLevel=Math.max(0,this.indentationLevel-1),this},n.prototype.addStyle=function(t,e,r){if(!1===this[t]||(this.hasOwnProperty(t)||n.prototype[t])&&!Object.prototype.hasOwnProperty.call(this.styles,t)&&-1===c.indexOf(t))throw new Error('"'+t+'" style cannot be defined, it clashes with a built-in attribute');if((this.hasOwnProperty(t)||-1!==c.indexOf(t))&&"function"===typeof this[t]&&!r)throw new Error('"'+t+'" style is already defined, set 3rd arg (allowRedefinition) to true to define it anyway');return this._stylesHaveNotBeenClonedYet&&(this.styles=Object.create(this.styles),this._stylesHaveNotBeenClonedYet=!1),this.styles[t]=e,this[t]=function(){return e.apply(this,arguments),this},this},n.prototype.toString=function(t){if(t&&this.format&&t!==this.format)throw new Error("A pen with format: "+this.format+" cannot be serialized to: "+t);"auto"===(t=this.format||t||"text")&&(t=n.defaultFormat);var e=this._themes[t]||{};return new n.serializers[t](e).serialize(this.output)},n.prototype.text=function(){var t=arguments[0];if(""===t)return this;for(var e=new Array(arguments.length-1),n=1;n<arguments.length;n+=1)e[n-1]=arguments[n];if(-1!==(t=String(t)).indexOf("\n")){var r=t.split(/\n/);return r.forEach(function(t,n){t.length&&this.write({style:"text",args:{content:t,styles:e}}),n<r.length-1&&this.nl();},this),this}return this.write({style:"text",args:{content:t,styles:e}})},n.prototype.removeFormatting=function(){var t=this.clone();return this.output.forEach(function(e,n){t.output[n]=i(e.map(function(t){return"text"===t.style?{style:"text",args:{content:t.args.content,styles:[]}}:t}));}),t.indentationLevel=this.indentationLevel,t},n.prototype.getContentFromArguments=function(t){var e;if(t[0].isMagicPen)return this.ensureCompatibleFormat(t[0].format),t[0];if("function"==typeof t[0])return e=this.clone(),t[0].call(e,e),e;if("string"==typeof t[0]&&1===t.length)return(e=this.clone()).text(t[0]),e;if("string"==typeof t[0])return(e=this.clone())[t[0]].apply(e,Array.prototype.slice.call(t,1)),e;throw new Error("Requires the arguments to be:\na pen or\na callback appending content to a pen or\na style and arguments for that style or\njust a string.")},n.prototype.isMultiline=function(){return this.output.length>1||this.size().height>1},n.prototype.isAtStartOfLine=function(){return 0===this.output.length||0===this.output[this.output.length-1].length},n.prototype.isBlock=function(){return 1===this.output.length&&1===this.output[0].length&&"block"===this.output[0][0].style},n.prototype.ensureCompatibleFormat=function(t){if(t&&this.format&&t!==this.format)throw new Error("This pen is only compatible with the format: "+this.format)},n.prototype.block=function(){var t=this.getContentFromArguments(arguments).output.map(function(t){return[].concat(t)});return this.write({style:"block",args:t})},n.prototype.alt=function(t){var e=this.format;if(!e)throw new Error("The alt method is only supported on pen where the format has already been set");var n=t[e];return void 0===n?t.fallback?this.append(t.fallback):this:"string"==typeof n||o(n)?this.raw(n):this.append(n)},n.prototype.raw=function(t){if(!this.format)throw new Error("The alt method is only supported on pen where the format has already been set");if("string"==typeof t)return this.write({style:"raw",args:{height:0,width:0,content:function(){return t}}});if(o(t)){if("string"==typeof t.content){var e=(t=u({},t)).content;t.content=function(){return e};}return this.write({style:"raw",args:t})}throw new Error("Raw "+this.format+" content needs to adhere to one of the following forms:\na string of raw content\na function returning a string of raw content or\nan object with the following form { width: <number>, height: <number>, content: <string function() {}|string> }")},n.prototype.amend=function(){var t=this.getContentFromArguments(arguments);return t.isEmpty()?this:(this.output=s(this.output,t),this)},n.prototype.append=function(){var t=this.getContentFromArguments(arguments);if(t.isEmpty())return this;var e=this.output[this.output.length-1];return Array.prototype.push.apply(e,t.output[0]),this.output[this.output.length-1]=i(e),this.output.push.apply(this.output,t.output.slice(1)),this},n.prototype.prependLinesWith=function(){var t=this.getContentFromArguments(arguments);if(t.isEmpty())return this;if(t.output.length>1)throw new Error("PrependLinesWith only supports a pen with single line content");var e=this.size().height,n=this.clone();return n.block(function(){for(var n=0;n<e;n+=1)0<n&&this.nl(),this.append(t);}),n.block(this),this.output=n.output,this},n.prototype.space=n.prototype.sp=function(t){return 0===t?this:(void 0===t&&(t=1),this.text(Kn(" ",t)))},c.forEach(function(t){n.prototype[t]=n.prototype[t.toLowerCase()]=function(e){return this.text(e,t)};}),n.prototype.clone=function(t){function e(){}this.isEmpty()||this.ensureCompatibleFormat(t),e.prototype=this;var n=new e;return n.styles=this.styles,n._stylesHaveNotBeenClonedYet=!0,n.indentationLevel=0,n.output=[[]],n.installedPlugins=[],n._themes=this._themes,n._themesHaveNotBeenClonedYet=!0,n.format=t||this.format,n.parent=this,n},n.prototype.isMagicPen=!0,n.prototype.size=function(){return $n.calculateSize(this.output)},n.prototype.use=function(t){var e=$n.findFirst(this.installedPlugins,function(e){if(e===t)return!0;if("function"==typeof t&&"function"==typeof e){var n=$n.getFunctionName(t);return""!==n&&n===$n.getFunctionName(e)}return e.name===t.name});if(e){if(e===t||void 0!==t.version&&t.version===e.version)return this;throw new Error("Another instance of the plugin '"+t.name+"' is already installed"+(void 0!==e.version?" (version "+e.version+(void 0!==t.version?", trying to install "+t.version:"")+")":"")+". Please check your node_modules folder for unmet peerDependencies.")}if("function"!=typeof t&&("object"!=typeof t||"function"!=typeof t.installInto)||void 0!==t.name&&"string"!=typeof t.name||void 0!==t.dependencies&&!Array.isArray(t.dependencies))throw new Error("Plugins must be functions or adhere to the following interface\n{\n  name: <an optional plugin name>,\n  version: <an optional semver version string>,\n  dependencies: <an optional list of dependencies>,\n  installInto: <a function that will update the given magicpen instance>\n}");if(t.dependencies){var n=this,r=[];do{r.push(n),n=n.parent;}while(n);var i=t.dependencies.filter(function(t){return!r.some(function(e){return e.installedPlugins.some(function(e){return e.name===t})})});if(1===i.length)throw new Error(t.name+" requires plugin "+i[0]);if(i.length>1)throw new Error(t.name+" requires plugins "+i.slice(0,-1).join(", ")+" and "+i[i.length-1])}return this.installedPlugins.push(t),"function"==typeof t?t(this):t.installInto(this),this},n.prototype.installPlugin=n.prototype.use,n.prototype.isEmpty=function(){return 1===this.output.length&&0===this.output[0].length},n.prototype.replaceText=function(t,e){if(this.isEmpty())return this;if("string"==typeof t&&(t=new RegExp($n.escapeRegExp(t),"g")),"string"==typeof e){var n=e;e=function(t,e){var r=[n].concat(t);this.text.apply(this,r);};}return 1===arguments.length&&(e=t,t=/.*/),this.output=a(this.clone(),this.output,t,e),this},n.prototype.theme=function(t){if(!(t=t||this.format))throw new Error("Could not detect which format you want to retrieve theme information for. Set the format of the pen or provide it as an argument to the theme method.");return this._themes[t]},n.prototype.installTheme=function(t,e){var r=this;if(1===arguments.length&&(e=t,t=Object.keys(n.serializers)),"string"==typeof t&&(t=[t]),"object"!=typeof e||!Array.isArray(t)||t.some(function(t){return"string"!=typeof t}))throw new Error("Themes must be installed the following way:\nInstall theme for all formats: pen.installTheme({ comment: 'gray' })\nInstall theme for a specific format: pen.installTheme('ansi', { comment: 'gray' }) or\nInstall theme for a list of formats: pen.installTheme(['ansi', 'html'], { comment: 'gray' })");if(e.styles&&"object"==typeof e.styles||(e={styles:e}),r._themesHaveNotBeenClonedYet){var i={};Object.keys(r._themes).forEach(function(t){i[t]=Object.create(r._themes[t]);}),r._themes=i,r._themesHaveNotBeenClonedYet=!1;}return Object.keys(e.styles).forEach(function(t){if(Qn.test(t)||Gn[t])throw new Error("Invalid theme key: '"+t+"' you can't map build styles.");r[t]||r.addStyle(t,function(e){this.text(e,t);});}),t.forEach(function(t){var n=r._themes[t]||{styles:{}},i=u({},n,e);i.styles=u({},n.styles,e.styles),r._themes[t]=i;}),this},t.exports=n;}),Mr=[],Rr=[],Br=function(t,e){if(t===e)return 0;var n=t.length,r=e.length;if(0===n)return r;if(0===r)return n;for(var i,o,s,a,u=0,c=0;u<n;)Rr[u]=t.charCodeAt(u),Mr[u]=++u;for(;c<r;)for(i=e.charCodeAt(c),s=c++,o=c,u=0;u<n;u++)a=i===Rr[u]?s:s+1,s=Mr[u],o=Mr[u]=s>o?a>o?o+1:a:a>s?s+1:a;return o},Ir=t(function(t){var e=function(){return void 0===this}();if(e)t.exports={freeze:Object.freeze,defineProperty:Object.defineProperty,getDescriptor:Object.getOwnPropertyDescriptor,keys:Object.keys,names:Object.getOwnPropertyNames,getPrototypeOf:Object.getPrototypeOf,isArray:Array.isArray,isES5:e,propertyIsWritable:function(t,e){var n=Object.getOwnPropertyDescriptor(t,e);return!(n&&!n.writable&&!n.set)}};else{var n={}.hasOwnProperty,r={}.toString,i={}.constructor.prototype,o=function(t){var e=[];for(var r in t)n.call(t,r)&&e.push(r);return e};t.exports={isArray:function(t){try{return"[object Array]"===r.call(t)}catch(t){return!1}},keys:o,names:o,defineProperty:function(t,e,n){return t[e]=n.value,t},getDescriptor:function(t,e){return{value:t[e]}},freeze:function(t){return t},getPrototypeOf:function(t){try{return Object(t).constructor.prototype}catch(t){return i}},isES5:e,propertyIsWritable:function(){return!0}};}}),Lr="undefined"==typeof navigator,Nr=function(){try{var t={};return Ir.defineProperty(t,"f",{get:function(){return 3}}),3===t.f}catch(t){return!1}}(),Ur={e:{}},zr,qr=function(t,e){function n(){this.constructor=t,this.constructor$=e;for(var n in e.prototype)r.call(e.prototype,n)&&"$"!==n.charAt(n.length-1)&&(this[n+"$"]=e.prototype[n]);}var r={}.hasOwnProperty;return n.prototype=e.prototype,t.prototype=new n,t.prototype},Hr=function(){var t=[Array.prototype,Object.prototype,Function.prototype],e=function(e){for(var n=0;n<t.length;++n)if(t[n]===e)return!0;return!1};if(Ir.isES5){var n=Object.getOwnPropertyNames;return function(t){for(var r=[],i=Object.create(null);null!=t&&!e(t);){var o;try{o=n(t);}catch(t){return r}for(var s=0;s<o.length;++s){var a=o[s];if(!i[a]){i[a]=!0;var u=Object.getOwnPropertyDescriptor(t,a);null!=u&&null==u.get&&null==u.set&&r.push(a);}}t=Ir.getPrototypeOf(t);}return r}}var r={}.hasOwnProperty;return function(n){if(e(n))return[];var i=[];t:for(var o in n)if(r.call(n,o))i.push(o);else{for(var s=0;s<t.length;++s)if(r.call(t[s],o))continue t;i.push(o);}return i}}(),$r=/this\s*\.\s*\S+\s*=/,Yr=/^[a-z$_][a-z$_0-9]*$/i,Wr="stack"in new Error?function(t){return et(t)?t:new Error(X(t))}:function(t){if(et(t))return t;try{throw new Error(X(t))}catch(t){return t}},Vr={isClass:K,isIdentifier:J,inheritedDataKeys:Hr,getDataPropertyOrDefault:Y,thrower:V,isArray:Ir.isArray,haveGetters:Nr,notEnumerableProp:W,isPrimitive:z,isObject:q,canEvaluate:Lr,errorObj:Ur,tryCatch:U,inherits:qr,withAppended:$,maybeWrapAsError:H,toFastProperties:Q,filledRange:G,toString:X,canAttachTrace:et,ensureErrorObject:Wr,originatesFromRejection:tt,markAsOriginatingFromRejection:Z,classString:nt,copyDescriptors:rt,hasDevTools:"undefined"!=typeof chrome&&chrome&&"function"==typeof chrome.loadTimes,isNode:void 0!==zn&&"[object process]"===nt(zn).toLowerCase()};Vr.isRecentNode=Vr.isNode&&function(){var t=zn.versions.node.split(".").map(Number);return 0===t[0]&&t[1]>10||t[0]>0}(),Vr.isNode&&Vr.toFastProperties(zn);try{throw new Error}catch(t){Vr.lastLineError=t;}var Kr=Vr,Qr,Jr=function(){throw new Error("No async scheduler available\n\n    See http://goo.gl/m3OTXk\n")};if(Kr.isNode&&"undefined"==typeof MutationObserver){var Gr=on.setImmediate,Xr=a;Qr=Kr.isRecentNode?function(t){Gr.call(on,t);}:function(t){Xr.call(zn,t);};}else"undefined"==typeof MutationObserver||"undefined"!=typeof window&&window.navigator&&window.navigator.standalone?Qr="undefined"!=typeof setImmediate?function(t){setImmediate(t);}:"undefined"!=typeof setTimeout?function(t){setTimeout(t,0);}:Jr:(Qr=function(t){var e=document.createElement("div");return new MutationObserver(t).observe(e,{attributes:!0}),function(){e.classList.toggle("foo");}},Qr.isStatic=!0);var Zr=Qr;ot.prototype._willBeOverCapacity=function(t){return this._capacity<t},ot.prototype._pushOne=function(t){var e=this.length();this._checkCapacity(e+1),this[this._front+e&this._capacity-1]=t,this._length=e+1;},ot.prototype._unshiftOne=function(t){var e=this._capacity;this._checkCapacity(this.length()+1);var n=(this._front-1&e-1^e)-e;this[n]=t,this._front=n,this._length=this.length()+1;},ot.prototype.unshift=function(t,e,n){this._unshiftOne(n),this._unshiftOne(e),this._unshiftOne(t);},ot.prototype.push=function(t,e,n){var r=this.length()+3;if(this._willBeOverCapacity(r))return this._pushOne(t),this._pushOne(e),void this._pushOne(n);var i=this._front+r-3;this._checkCapacity(r);var o=this._capacity-1;this[i+0&o]=t,this[i+1&o]=e,this[i+2&o]=n,this._length=r;},ot.prototype.shift=function(){var t=this._front,e=this[t];return this[t]=void 0,this._front=t+1&this._capacity-1,this._length--,e},ot.prototype.length=function(){return this._length},ot.prototype._checkCapacity=function(t){this._capacity<t&&this._resizeTo(this._capacity<<1);},ot.prototype._resizeTo=function(t){var e=this._capacity;this._capacity=t,it(this,0,this,e,this._front+this._length&e-1);};var ti=ot,ei;try{throw new Error}catch(t){ei=t;}var ni=Zr;st.prototype.disableTrampolineIfNecessary=function(){Kr.hasDevTools&&(this._trampolineEnabled=!1);},st.prototype.enableTrampoline=function(){this._trampolineEnabled||(this._trampolineEnabled=!0,this._schedule=function(t){setTimeout(t,0);});},st.prototype.haveItemsQueued=function(){return this._normalQueue.length()>0},st.prototype.throwLater=function(t,e){if(1===arguments.length&&(e=t,t=function(){throw e}),"undefined"!=typeof setTimeout)setTimeout(function(){t(e);},0);else try{this._schedule(function(){t(e);});}catch(t){throw new Error("No async scheduler available\n\n    See http://goo.gl/m3OTXk\n")}},Kr.hasDevTools?(ni.isStatic&&(ni=function(t){setTimeout(t,0);}),st.prototype.invokeLater=function(t,e,n){this._trampolineEnabled?at.call(this,t,e,n):this._schedule(function(){setTimeout(function(){t.call(e,n);},100);});},st.prototype.invoke=function(t,e,n){this._trampolineEnabled?ut.call(this,t,e,n):this._schedule(function(){t.call(e,n);});},st.prototype.settlePromises=function(t){this._trampolineEnabled?ct.call(this,t):this._schedule(function(){t._settlePromises();});}):(st.prototype.invokeLater=at,st.prototype.invoke=ut,st.prototype.settlePromises=ct),st.prototype.invokeFirst=function(t,e,n){this._normalQueue.unshift(t,e,n),this._queueTick();},st.prototype._drainQueue=function(t){for(;t.length()>0;){var e=t.shift();if("function"==typeof e){var n=t.shift(),r=t.shift();e.call(n,r);}else e._settlePromises();}},st.prototype._drainQueues=function(){this._drainQueue(this._normalQueue),this._reset(),this._drainQueue(this._lateQueue);},st.prototype._queueTick=function(){this._isTickUsed||(this._isTickUsed=!0,this._schedule(this.drainQueues));},st.prototype._reset=function(){this._isTickUsed=!1;};var ri=new st,ii=ei;ri.firstLineError=ii;var oi=Ir.freeze,si=Kr.inherits,ai=Kr.notEnumerableProp,ui,ci,fi=ft("Warning","warning"),li=ft("CancellationError","cancellation error"),hi=ft("TimeoutError","timeout error"),pi=ft("AggregateError","aggregate error");try{ui=TypeError,ci=RangeError;}catch(t){ui=ft("TypeError","type error"),ci=ft("RangeError","range error");}for(var di="join pop push shift unshift slice filter forEach some every map indexOf lastIndexOf reduce reduceRight sort reverse".split(" "),yi=0;yi<di.length;++yi)"function"==typeof Array.prototype[di[yi]]&&(pi.prototype[di[yi]]=Array.prototype[di[yi]]);Ir.defineProperty(pi.prototype,"length",{value:0,configurable:!1,writable:!0,enumerable:!0}),pi.prototype.isOperational=!0;var gi=0;pi.prototype.toString=function(){var t=Array(4*gi+1).join(" "),e="\n"+t+"AggregateError of:\n";gi++,t=Array(4*gi+1).join(" ");for(var n=0;n<this.length;++n){for(var r=this[n]===this?"[Circular AggregateError]":this[n]+"",i=r.split("\n"),o=0;o<i.length;++o)i[o]=t+i[o];e+=(r=i.join("\n"))+"\n";}return gi--,e},si(lt,Error);var vi=Error.__BluebirdErrorTypes__;vi||(vi=oi({CancellationError:li,TimeoutError:hi,OperationalError:lt,RejectionError:lt,AggregateError:pi}),ai(Error,"__BluebirdErrorTypes__",vi));var mi={Error:Error,TypeError:ui,RangeError:ci,CancellationError:vi.CancellationError,OperationalError:vi.OperationalError,TimeoutError:vi.TimeoutError,AggregateError:vi.AggregateError,Warning:fi},bi=function(t,e){function n(t){return t.then}function r(t){return u.call(t,"_promise0")}function i(n,r,i){var a=new t(e),u=a;i&&i._pushContext(),a._captureStackTrace(),i&&i._popContext();var c=!0,f=o.tryCatch(r).call(n,function(t){a&&(a._resolveCallback(t),a=null);},function(t){a&&(a._rejectCallback(t,c,!0),a=null);},function(t){a&&"function"==typeof a._progress&&a._progress(t);});return c=!1,a&&f===s&&(a._rejectCallback(f.e,!0,!0),a=null),u}var o=Kr,s=o.errorObj,a=o.isObject,u={}.hasOwnProperty;return function(u,c){if(a(u)){if(u instanceof t)return u;if(r(u))return l=new t(e),u._then(l._fulfillUnchecked,l._rejectUncheckedCheckError,l._progressUnchecked,l,null),l;var f=o.tryCatch(n)(u);if(f===s){c&&c._pushContext();var l=t.reject(f.e);return c&&c._popContext(),l}if("function"==typeof f)return i(u,f,c)}return u}},_i=function(t,e,n,r){function i(t){switch(t){case-2:return[];case-3:return{}}}function o(n){var r,i=this._promise=new t(e);n instanceof t&&(r=n,i._propagateFrom(r,5)),this._values=n,this._length=0,this._totalResolved=0,this._init(void 0,-2);}var s=Kr.isArray;return o.prototype.length=function(){return this._length},o.prototype.promise=function(){return this._promise},o.prototype._init=function e(o,a){var u=n(this._values,this._promise);if(u instanceof t){if(u=u._target(),this._values=u,!u._isFulfilled())return u._isPending()?void u._then(e,this._reject,void 0,this,a):void this._reject(u._reason());if(u=u._value(),!s(u)){var c=new t.TypeError("expecting an array, a promise or a thenable\n\n    See http://goo.gl/s8MMhc\n");return void this.__hardReject__(c)}}else if(!s(u))return void this._promise._reject(r("expecting an array, a promise or a thenable\n\n    See http://goo.gl/s8MMhc\n")._reason());if(0!==u.length){var f=this.getActualLength(u.length);this._length=f,this._values=this.shouldCopyValues()?new Array(f):this._values;for(var l=this._promise,h=0;h<f;++h){var p=this._isResolved(),d=n(u[h],l);d instanceof t?(d=d._target(),p?d._ignoreRejections():d._isPending()?d._proxyPromiseArray(this,h):d._isFulfilled()?this._promiseFulfilled(d._value(),h):this._promiseRejected(d._reason(),h)):p||this._promiseFulfilled(d,h);}}else-5===a?this._resolveEmptyArray():this._resolve(i(a));},o.prototype._isResolved=function(){return null===this._values},o.prototype._resolve=function(t){this._values=null,this._promise._fulfill(t);},o.prototype.__hardReject__=o.prototype._reject=function(t){this._values=null,this._promise._rejectCallback(t,!1,!0);},o.prototype._promiseProgressed=function(t,e){this._promise._progress({index:e,value:t});},o.prototype._promiseFulfilled=function(t,e){this._values[e]=t,++this._totalResolved>=this._length&&this._resolve(this._values);},o.prototype._promiseRejected=function(t,e){this._totalResolved++,this._reject(t);},o.prototype.shouldCopyValues=function(){return!0},o.prototype.getActualLength=function(t){return t},o},wi=function(){function t(e){this._parent=e;var n=this._length=1+(void 0===e?0:e._length);b(this,t),n>32&&this.uncycle();}function e(t,e){for(var n=0;n<e.length-1;++n)e[n].push("From previous event:"),e[n]=e[n].join("\n");return n<e.length&&(e[n]=e[n].join("\n")),t+"\n"+e.join("\n")}function n(t){for(var e=0;e<t.length;++e)(0===t[e].length||e+1<t.length&&t[e][0]===t[e+1][0])&&(t.splice(e,1),e--);}function r(t){for(var e=t[0],n=1;n<t.length;++n){for(var r=t[n],i=e.length-1,o=e[i],s=-1,a=r.length-1;a>=0;--a)if(r[a]===o){s=a;break}for(a=s;a>=0;--a){var u=r[a];if(e[i]!==u)break;e.pop(),i--;}e=r;}}function i(t){for(var e=[],n=0;n<t.length;++n){var r=t[n],i=p.test(r)||"    (No stack trace)"===r,o=i&&g(r);i&&!o&&(y&&" "!==r.charAt(0)&&(r="    "+r),e.push(r));}return e}function o(t){for(var e=t.stack.replace(/\s+$/g,"").split("\n"),n=0;n<e.length;++n){var r=e[n];if("    (No stack trace)"===r||p.test(r))break}return n>0&&(e=e.slice(n)),e}function s(t){var e;if("function"==typeof t)e="[function "+(t.name||"anonymous")+"]";else{if(e=t.toString(),/\[object [a-zA-Z0-9$_]+\]/.test(e))try{e=JSON.stringify(t);}catch(t){}0===e.length&&(e="(empty array)");}return"(<"+a(e)+">, no stack trace)"}function a(t){return t.length<41?t:t.substr(0,38)+"..."}function u(t){var e=t.match(v);if(e)return{fileName:e[1],line:parseInt(e[2],10)}}var c,f=ri,l=Kr,h=/[\\\/]bluebird[\\\/]js[\\\/](main|debug|zalgo|instrumented)/,p=null,d=null,y=!1;l.inherits(t,Error),t.prototype.uncycle=function(){var t=this._length;if(!(t<2)){for(var e=[],n={},r=0,i=this;void 0!==i;++r)e.push(i),i=i._parent;for(r=(t=this._length=r)-1;r>=0;--r){var o=e[r].stack;void 0===n[o]&&(n[o]=r);}for(r=0;r<t;++r){var s=n[e[r].stack];if(void 0!==s&&s!==r){s>0&&(e[s-1]._parent=void 0,e[s-1]._length=1),e[r]._parent=void 0,e[r]._length=1;var a=r>0?e[r-1]:this;s<t-1?(a._parent=e[s+1],a._parent.uncycle(),a._length=a._parent._length+1):(a._parent=void 0,a._length=1);for(var u=a._length+1,c=r-2;c>=0;--c)e[c]._length=u,u++;return}}}},t.prototype.parent=function(){return this._parent},t.prototype.hasParent=function(){return void 0!==this._parent},t.prototype.attachExtraTrace=function(o){if(!o.__stackCleaned__){this.uncycle();for(var s=t.parseStackAndMessage(o),a=s.message,u=[s.stack],c=this;void 0!==c;)u.push(i(c.stack.split("\n"))),c=c._parent;r(u),n(u),l.notEnumerableProp(o,"stack",e(a,u)),l.notEnumerableProp(o,"__stackCleaned__",!0);}},t.parseStackAndMessage=function(t){var e=t.stack,n=t.toString();return e="string"==typeof e&&e.length>0?o(t):["    (No stack trace)"],{message:n,stack:i(e)}},t.formatAndLogError=function(t,e){if("undefined"!=typeof console){var n;if("object"==typeof t||"function"==typeof t){var r=t.stack;n=e+d(r,t);}else n=e+String(t);"function"==typeof c?c(n):"function"!=typeof console.log&&"object"!=typeof console.log||console.log(n);}},t.unhandledRejection=function(e){t.formatAndLogError(e,"^--- With additional stack trace: ");},t.isSupported=function(){return"function"==typeof b},t.fireRejectionEvent=function(e,n,r,i){var o=!1;try{"function"==typeof n&&(o=!0,"rejectionHandled"===e?n(i):n(r,i));}catch(t){f.throwLater(t);}var s=!1;try{s=_(e,r,i);}catch(t){s=!0,f.throwLater(t);}var a=!1;if(m)try{a=m(e.toLowerCase(),{reason:r,promise:i});}catch(t){a=!0,f.throwLater(t);}s||o||a||"unhandledRejection"!==e||t.formatAndLogError(r,"Unhandled rejection ");};var g=function(){return!1},v=/[\/<\(]([^:\/]+):(\d+):(?:\d+)\)?\s*$/;t.setBounds=function(e,n){if(t.isSupported()){for(var r,i,o=e.stack.split("\n"),s=n.stack.split("\n"),a=-1,c=-1,f=0;f<o.length;++f)if(l=u(o[f])){r=l.fileName,a=l.line;break}for(f=0;f<s.length;++f){var l=u(s[f]);if(l){i=l.fileName,c=l.line;break}}a<0||c<0||!r||!i||r!==i||a>=c||(g=function(t){if(h.test(t))return!0;var e=u(t);return!!(e&&e.fileName===r&&a<=e.line&&e.line<=c)});}};var m,b=function(){var t=/^\s*at\s*/,e=function(t,e){return"string"==typeof t?t:void 0!==e.name&&void 0!==e.message?e.toString():s(e)};if("number"==typeof Error.stackTraceLimit&&"function"==typeof Error.captureStackTrace){Error.stackTraceLimit=Error.stackTraceLimit+6,p=t,d=e;var n=Error.captureStackTrace;return g=function(t){return h.test(t)},function(t,e){Error.stackTraceLimit=Error.stackTraceLimit+6,n(t,e),Error.stackTraceLimit=Error.stackTraceLimit-6;}}var r=new Error;if("string"==typeof r.stack&&r.stack.split("\n")[0].indexOf("stackDetection@")>=0)return p=/@/,d=e,y=!0,function(t){t.stack=(new Error).stack;};var i;try{throw new Error}catch(t){i="stack"in t;}return"stack"in r||!i||"number"!=typeof Error.stackTraceLimit?(d=function(t,e){return"string"==typeof t?t:"object"!=typeof e&&"function"!=typeof e||void 0===e.name||void 0===e.message?s(e):e.toString()},null):(p=t,d=e,function(t){Error.stackTraceLimit=Error.stackTraceLimit+6;try{throw new Error}catch(e){t.stack=e.stack;}Error.stackTraceLimit=Error.stackTraceLimit-6;})}(),_=function(){if(l.isNode)return function(t,e,n){return"rejectionHandled"===t?zn.emit(t,n):zn.emit(t,e,n)};var t=!1,e=!0;try{var n=new self.CustomEvent("test");t=n instanceof CustomEvent;}catch(t){}if(!t)try{var r=document.createEvent("CustomEvent");r.initCustomEvent("testingtheevent",!1,!0,{}),self.dispatchEvent(r);}catch(t){e=!1;}e&&(m=function(e,n){var r;return t?r=new self.CustomEvent(e,{detail:n,bubbles:!1,cancelable:!0}):self.dispatchEvent&&(r=document.createEvent("CustomEvent")).initCustomEvent(e,!1,!0,n),!!r&&!self.dispatchEvent(r)});var i={};return i.unhandledRejection="onunhandledRejection".toLowerCase(),i.rejectionHandled="onrejectionHandled".toLowerCase(),function(t,e,n){var r=i[t],o=self[r];return!!o&&("rejectionHandled"===t?o.call(self,n):o.call(self,e,n),!0)}}();return"undefined"!=typeof console&&void 0!==console.warn&&(c=function(t){console.warn(t);},l.isNode&&zn.stderr.isTTY?c=function(t){zn.stderr.write("[31m"+t+"[39m\n");}:l.isNode||"string"!=typeof(new Error).stack||(c=function(t){console.warn("%c"+t,"color: red");})),t},Ei=function(t,e){var n,r,i=t._getDomain,o=ri,s=mi.Warning,a=Kr,u=a.canAttachTrace,c=a.isNode&&(!!zn.env.BLUEBIRD_DEBUG||"development"===zn.env.NODE_ENV);return c&&o.disableTrampolineIfNecessary(),t.prototype._ignoreRejections=function(){this._unsetRejectionIsUnhandled(),this._bitField=16777216|this._bitField;},t.prototype._ensurePossibleRejectionHandled=function(){0==(16777216&this._bitField)&&(this._setRejectionIsUnhandled(),o.invokeLater(this._notifyUnhandledRejection,this,void 0));},t.prototype._notifyUnhandledRejectionIsHandled=function(){e.fireRejectionEvent("rejectionHandled",n,void 0,this);},t.prototype._notifyUnhandledRejection=function(){if(this._isRejectionUnhandled()){var t=this._getCarriedStackTrace()||this._settledValue;this._setUnhandledRejectionIsNotified(),e.fireRejectionEvent("unhandledRejection",r,t,this);}},t.prototype._setUnhandledRejectionIsNotified=function(){this._bitField=524288|this._bitField;},t.prototype._unsetUnhandledRejectionIsNotified=function(){this._bitField=-524289&this._bitField;},t.prototype._isUnhandledRejectionNotified=function(){return(524288&this._bitField)>0},t.prototype._setRejectionIsUnhandled=function(){this._bitField=2097152|this._bitField;},t.prototype._unsetRejectionIsUnhandled=function(){this._bitField=-2097153&this._bitField,this._isUnhandledRejectionNotified()&&(this._unsetUnhandledRejectionIsNotified(),this._notifyUnhandledRejectionIsHandled());},t.prototype._isRejectionUnhandled=function(){return(2097152&this._bitField)>0},t.prototype._setCarriedStackTrace=function(t){this._bitField=1048576|this._bitField,this._fulfillmentHandler0=t;},t.prototype._isCarryingStackTrace=function(){return(1048576&this._bitField)>0},t.prototype._getCarriedStackTrace=function(){return this._isCarryingStackTrace()?this._fulfillmentHandler0:void 0},t.prototype._captureStackTrace=function(t){return(c||t&&e.isSupported())&&(this._traceForced=t,this._trace=new e(this._peekContext())),this},t.prototype._attachExtraTrace=function(t,n){if((c||this._traceForced)&&u(t)){var r=this._trace;if(void 0!==r&&n&&(r=r._parent),void 0!==r)r.attachExtraTrace(t);else if(!t.__stackCleaned__){var i=e.parseStackAndMessage(t);a.notEnumerableProp(t,"stack",i.message+"\n"+i.stack.join("\n")),a.notEnumerableProp(t,"__stackCleaned__",!0);}}},t.prototype._warn=function(t){var n=new s(t),r=this._peekContext();if(r)r.attachExtraTrace(n);else{var i=e.parseStackAndMessage(n);n.stack=i.message+"\n"+i.stack.join("\n");}e.formatAndLogError(n,"");},t.onPossiblyUnhandledRejection=function(t){var e=i();r="function"==typeof t?null===e?t:e.bind(t):void 0;},t.onUnhandledRejectionHandled=function(t){var e=i();n="function"==typeof t?null===e?t:e.bind(t):void 0;},t.longStackTraces=function(){if(o.haveItemsQueued()&&!1===c)throw new Error("cannot enable long stack traces after promises have been created\n\n    See http://goo.gl/DT1qyG\n");(c=e.isSupported())&&o.disableTrampolineIfNecessary();},t.hasLongStackTraces=function(){return c&&e.isSupported()},e.isSupported()||(t.longStackTraces=function(){},c=!1),function(){return c}},xi=function(t,e,n){function r(){this._trace=new e(i());}function i(){var t=o.length-1;if(t>=0)return o[t]}var o=[];return r.prototype._pushContext=function(){n()&&void 0!==this._trace&&o.push(this._trace);},r.prototype._popContext=function(){n()&&void 0!==this._trace&&o.pop();},t.prototype._peekContext=i,t.prototype._pushContext=r.prototype._pushContext,t.prototype._popContext=r.prototype._popContext,function(){if(n())return new r}},Ai=function(t){function e(t,e,n){this._instances=t,this._callback=e,this._promise=n;}function n(t,e){var n={},r=o(t).call(n,e);return r===s?r:a(n).length?(s.e=new u("Catch filter must inherit from Error or be a simple predicate function\n\n    See http://goo.gl/o84o68\n"),s):r}var r=Kr,i=mi,o=r.tryCatch,s=r.errorObj,a=Ir.keys,u=i.TypeError;return e.prototype.doFilter=function(e){for(var r=this._callback,i=this._promise._boundValue(),a=0,u=this._instances.length;a<u;++a){var c=this._instances[a],f=c===Error||null!=c&&c.prototype instanceof Error;if(f&&e instanceof c)return(h=o(r).call(i,e))===s?(t.e=h.e,t):h;if("function"==typeof c&&!f){var l=n(c,e);if(l===s){e=s.e;break}if(l){var h=o(r).call(i,e);return h===s?(t.e=h.e,t):h}}}return t.e=e,t},e},Fi=Kr.maybeWrapAsError,ji=mi.TimeoutError,ki=mi.OperationalError,Ci=Kr.haveGetters,Si=/^(?:name|message|stack|cause)$/,Ti;if(Ti=Ci?function(t){this.promise=t;}:function(t){this.promise=t,this.asCallback=dt(t),this.callback=this.asCallback;},Ci){var Oi={get:function(){return dt(this.promise)}};Ir.defineProperty(Ti.prototype,"asCallback",Oi),Ir.defineProperty(Ti.prototype,"callback",Oi);}Ti._nodebackForPromise=dt,Ti.prototype.toString=function(){return"[object PromiseResolver]"},Ti.prototype.resolve=Ti.prototype.fulfill=function(t){if(!(this instanceof Ti))throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.\n\n    See http://goo.gl/sdkXL9\n");this.promise._resolveCallback(t);},Ti.prototype.reject=function(t){if(!(this instanceof Ti))throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.\n\n    See http://goo.gl/sdkXL9\n");this.promise._rejectCallback(t);},Ti.prototype.progress=function(t){if(!(this instanceof Ti))throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.\n\n    See http://goo.gl/sdkXL9\n");this.promise._progress(t);},Ti.prototype.cancel=function(t){this.promise.cancel(t);},Ti.prototype.timeout=function(){this.reject(new ji("timeout"));},Ti.prototype.isResolved=function(){return this.promise.isResolved()},Ti.prototype.toJSON=function(){return this.promise.toJSON()};var Pi=Ti,Di=function(t,e){var n=Kr,r=ri,i=n.tryCatch,o=n.errorObj;t.prototype.progressed=function(t){return this._then(void 0,void 0,t,void 0,void 0)},t.prototype._progress=function(t){this._isFollowingOrFulfilledOrRejected()||this._target()._progressUnchecked(t);},t.prototype._progressHandlerAt=function(t){return 0===t?this._progressHandler0:this[(t<<2)+t-5+2]},t.prototype._doProgressWith=function(e){var r=e.value,s=e.handler,a=e.promise,u=e.receiver,c=i(s).call(u,r);if(c===o){if(null!=c.e&&"StopProgressPropagation"!==c.e.name){var f=n.canAttachTrace(c.e)?c.e:new Error(n.toString(c.e));a._attachExtraTrace(f),a._progress(c.e);}}else c instanceof t?c._then(a._progress,null,null,a,void 0):a._progress(c);},t.prototype._progressUnchecked=function(n){for(var i=this._length(),o=this._progress,s=0;s<i;s++){var a=this._progressHandlerAt(s),u=this._promiseAt(s);if(u instanceof t)"function"==typeof a?r.invoke(this._doProgressWith,this,{handler:a,promise:u,receiver:this._receiverAt(s),value:n}):r.invoke(o,u,n);else{var c=this._receiverAt(s);"function"==typeof a?a.call(c,n,u):c instanceof e&&!c._isResolved()&&c._promiseProgressed(n,u);}}};},Mi=function(t,e,n,r){var i=Kr,o=i.tryCatch;t.method=function(n){if("function"!=typeof n)throw new t.TypeError("fn must be a function\n\n    See http://goo.gl/916lJJ\n");return function(){var r=new t(e);r._captureStackTrace(),r._pushContext();var i=o(n).apply(this,arguments);return r._popContext(),r._resolveFromSyncValue(i),r}},t.attempt=t.try=function(n,s,a){if("function"!=typeof n)return r("fn must be a function\n\n    See http://goo.gl/916lJJ\n");var u=new t(e);u._captureStackTrace(),u._pushContext();var c=i.isArray(s)?o(n).apply(a,s):o(n).call(a,s);return u._popContext(),u._resolveFromSyncValue(c),u},t.prototype._resolveFromSyncValue=function(t){t===i.errorObj?this._rejectCallback(t.e,!1,!0):this._resolveCallback(t,!0);};},Ri=function(t,e,n){var r=function(t,e){this._reject(e);},i=function(t,e){e.promiseRejectionQueued=!0,e.bindingPromise._then(r,r,null,this,t);},o=function(t,e){this._isPending()&&this._resolveCallback(e.target);},s=function(t,e){e.promiseRejectionQueued||this._reject(t);};t.prototype.bind=function(r){var a=n(r),u=new t(e);u._propagateFrom(this,1);var c=this._target();if(u._setBoundTo(a),a instanceof t){var f={promiseRejectionQueued:!1,promise:u,target:c,bindingPromise:a};c._then(e,i,u._progress,u,f),a._then(o,s,u._progress,u,f);}else u._resolveCallback(c);return u},t.prototype._setBoundTo=function(t){void 0!==t?(this._bitField=131072|this._bitField,this._boundTo=t):this._bitField=-131073&this._bitField;},t.prototype._isBound=function(){return 131072==(131072&this._bitField)},t.bind=function(r,i){var o=n(r),s=new t(e);return s._setBoundTo(o),o instanceof t?o._then(function(){s._resolveCallback(i);},s._reject,s._progress,s,null):s._resolveCallback(i),s};},Bi=function(t,e,n){function r(){return this}function i(){throw this}function o(t){return function(){return t}}function s(t){return function(){throw t}}function a(t,e,n){var a;return a=l(e)?n?o(e):s(e):n?r:i,t._then(a,h,void 0,e,void 0)}function u(r){var i=this.promise,o=this.handler,s=i._isBound()?o.call(i._boundValue()):o();if(void 0!==s){var u=n(s,i);if(u instanceof t)return u=u._target(),a(u,r,i.isFulfilled())}return i.isRejected()?(e.e=r,e):r}function c(e){var r=this.promise,i=this.handler,o=r._isBound()?i.call(r._boundValue(),e):i(e);if(void 0!==o){var s=n(o,r);if(s instanceof t)return s=s._target(),a(s,e,!0)}return e}var f=Kr,l=f.isPrimitive,h=f.thrower;t.prototype._passThroughHandler=function(t,e){if("function"!=typeof t)return this.then();var n={promise:this,handler:t};return this._then(e?u:c,e?u:void 0,void 0,n,void 0)},t.prototype.lastly=t.prototype.finally=function(t){return this._passThroughHandler(t,!0)},t.prototype.tap=function(t){return this._passThroughHandler(t,!1)};},Ii=Kr.isPrimitive,Li=function(t){var e=function(){return this},n=function(){throw this},r=function(){},i=function(){throw void 0},o=function(t,e){return 1===e?function(){throw t}:2===e?function(){return t}:void 0};t.prototype.return=t.prototype.thenReturn=function(t){return void 0===t?this.then(r):Ii(t)?this._then(o(t,2),void 0,void 0,void 0,void 0):this._then(e,void 0,void 0,t,void 0)},t.prototype.throw=t.prototype.thenThrow=function(t){return void 0===t?this.then(i):Ii(t)?this._then(o(t,1),void 0,void 0,void 0,void 0):this._then(n,void 0,void 0,t,void 0)};},Ni=function(t){function e(t){void 0!==t?(t=t._target(),this._bitField=t._bitField,this._settledValue=t._settledValue):(this._bitField=0,this._settledValue=void 0);}e.prototype.value=function(){if(!this.isFulfilled())throw new TypeError("cannot get fulfillment value of a non-fulfilled promise\n\n    See http://goo.gl/hc1DLj\n");return this._settledValue},e.prototype.error=e.prototype.reason=function(){if(!this.isRejected())throw new TypeError("cannot get rejection reason of a non-rejected promise\n\n    See http://goo.gl/hPuiwB\n");return this._settledValue},e.prototype.isFulfilled=t.prototype._isFulfilled=function(){return(268435456&this._bitField)>0},e.prototype.isRejected=t.prototype._isRejected=function(){return(134217728&this._bitField)>0},e.prototype.isPending=t.prototype._isPending=function(){return 0==(402653184&this._bitField)},e.prototype.isResolved=t.prototype._isResolved=function(){return(402653184&this._bitField)>0},t.prototype.isPending=function(){return this._target()._isPending()},t.prototype.isRejected=function(){return this._target()._isRejected()},t.prototype.isFulfilled=function(){return this._target()._isFulfilled()},t.prototype.isResolved=function(){return this._target()._isResolved()},t.prototype._value=function(){return this._settledValue},t.prototype._reason=function(){return this._unsetRejectionIsUnhandled(),this._settledValue},t.prototype.value=function(){var t=this._target();if(!t.isFulfilled())throw new TypeError("cannot get fulfillment value of a non-fulfilled promise\n\n    See http://goo.gl/hc1DLj\n");return t._settledValue},t.prototype.reason=function(){var t=this._target();if(!t.isRejected())throw new TypeError("cannot get rejection reason of a non-rejected promise\n\n    See http://goo.gl/hPuiwB\n");return t._unsetRejectionIsUnhandled(),t._settledValue},t.PromiseInspection=e;},Ui=function(t,e,n,r){var i=Kr,o=i.canEvaluate,s=i.tryCatch,a=i.errorObj;if(o){for(var u=[],c=[void 0],f=1;f<=5;++f)u.push(function(t){return new Function("value","holder","                             \n            'use strict';                                                    \n            holder.pIndex = value;                                           \n            holder.checkFulfillment(this);                                   \n            ".replace(/Index/g,t))}(f)),c.push(function(t){for(var e=[],n=1;n<=t;++n)e.push("holder.p"+n);return new Function("holder","                                      \n            'use strict';                                                    \n            var callback = holder.fn;                                        \n            return callback(values);                                         \n            ".replace(/values/g,e.join(", ")))}(f));var l=function(t,e){this.p1=this.p2=this.p3=this.p4=this.p5=null,this.fn=e,this.total=t,this.now=0;};l.prototype.callers=c,l.prototype.checkFulfillment=function(t){var e=this.now;e++;var n=this.total;if(e>=n){var r=this.callers[n];t._pushContext();var i=s(r)(this);t._popContext(),i===a?t._rejectCallback(i.e,!1,!0):t._resolveCallback(i);}else this.now=e;};var h=function(t){this._reject(t);};}t.join=function(){var i,s=arguments.length-1;if(s>0&&"function"==typeof arguments[s]&&(i=arguments[s],s<6&&o)){(v=new t(r))._captureStackTrace();for(var a=new l(s,i),c=u,f=0;f<s;++f){var p=n(arguments[f],v);p instanceof t?(p=p._target())._isPending()?p._then(c[f],h,void 0,v,a):p._isFulfilled()?c[f].call(v,p._value(),a):v._reject(p._reason()):c[f].call(v,p,a);}return v}for(var d=arguments.length,y=new Array(d),g=0;g<d;++g)y[g]=arguments[g];i&&y.pop();var v=new e(y).promise();return void 0!==i?v.spread(i):v};},zi=function(t,e,n,r,i){function o(t,e,n,r){this.constructor$(t),this._promise._captureStackTrace();var o=u();this._callback=null===o?e:o.bind(e),this._preservedValues=r===i?new Array(this.length()):null,this._limit=n,this._inFlight=0,this._queue=n>=1?[]:d,c.invoke(s,this,void 0);}function s(){this._init$(void 0,-2);}function a(t,e,n,r){var i="object"==typeof n&&null!==n?n.concurrency:0;return i="number"==typeof i&&isFinite(i)&&i>=1?i:0,new o(t,e,i,r)}var u=t._getDomain,c=ri,f=Kr,l=f.tryCatch,h=f.errorObj,p={},d=[];f.inherits(o,e),o.prototype._init=function(){},o.prototype._promiseFulfilled=function(e,n){var i=this._values,o=this.length(),s=this._preservedValues,a=this._limit;if(i[n]===p){if(i[n]=e,a>=1&&(this._inFlight--,this._drainQueue(),this._isResolved()))return}else{if(a>=1&&this._inFlight>=a)return i[n]=e,void this._queue.push(n);null!==s&&(s[n]=e);var u=this._callback,c=this._promise._boundValue();this._promise._pushContext();var f=l(u).call(c,e,n,o);if(this._promise._popContext(),f===h)return this._reject(f.e);var d=r(f,this._promise);if(d instanceof t){if((d=d._target())._isPending())return a>=1&&this._inFlight++,i[n]=p,d._proxyPromiseArray(this,n);if(!d._isFulfilled())return this._reject(d._reason());f=d._value();}i[n]=f;}++this._totalResolved>=o&&(null!==s?this._filter(i,s):this._resolve(i));},o.prototype._drainQueue=function(){for(var t=this._queue,e=this._limit,n=this._values;t.length>0&&this._inFlight<e;){if(this._isResolved())return;var r=t.pop();this._promiseFulfilled(n[r],r);}},o.prototype._filter=function(t,e){for(var n=e.length,r=new Array(n),i=0,o=0;o<n;++o)t[o]&&(r[i++]=e[o]);r.length=i,this._resolve(r);},o.prototype.preservedValues=function(){return this._preservedValues},t.prototype.map=function(t,e){return"function"!=typeof t?n("fn must be a function\n\n    See http://goo.gl/916lJJ\n"):a(this,t,e,null).promise()},t.map=function(t,e,r,i){return"function"!=typeof e?n("fn must be a function\n\n    See http://goo.gl/916lJJ\n"):a(t,e,r,i).promise()};},qi=function(t){var e=ri,n=mi.CancellationError;t.prototype._cancel=function(t){if(!this.isCancellable())return this;for(var e,n=this;void 0!==(e=n._cancellationParent)&&e.isCancellable();)n=e;this._unsetCancellable(),n._target()._rejectCallback(t,!1,!0);},t.prototype.cancel=function(t){return this.isCancellable()?(void 0===t&&(t=new n),e.invokeLater(this._cancel,this,t),this):this},t.prototype.cancellable=function(){return this._cancellable()?this:(e.enableTrampoline(),this._setCancellable(),this._cancellationParent=void 0,this)},t.prototype.uncancellable=function(){var t=this.then();return t._unsetCancellable(),t},t.prototype.fork=function(t,e,n){var r=this._then(t,e,n,void 0,void 0);return r._setCancellable(),r._cancellationParent=void 0,r};},Hi=function(t,e,n,r){function i(e){for(var n=e.length,r=0;r<n;++r){var i=e[r];if(i.isRejected())return t.reject(i.error());e[r]=i._settledValue;}return e}function o(t){setTimeout(function(){throw t},0);}function s(t){var e=n(t);return e!==t&&"function"==typeof t._isDisposable&&"function"==typeof t._getDisposer&&t._isDisposable()&&e._setDisposable(t._getDisposer()),e}function a(e,r){function i(){if(a>=u)return c.resolve();var f=s(e[a++]);if(f instanceof t&&f._isDisposable()){try{f=n(f._getDisposer().tryDispose(r),e.promise);}catch(t){return o(t)}if(f instanceof t)return f._then(i,o,null,null,null)}i();}var a=0,u=e.length,c=t.defer();return i(),c.promise}function u(t){var e=new y;return e._settledValue=t,e._bitField=268435456,a(this,e).thenReturn(t)}function c(t){var e=new y;return e._settledValue=t,e._bitField=134217728,a(this,e).thenThrow(t)}function f(t,e,n){this._data=t,this._promise=e,this._context=n;}function l(t,e,n){this.constructor$(t,e,n);}function h(t){return f.isDisposer(t)?(this.resources[this.index]._setDisposable(t),t.promise()):t}var p=mi.TypeError,d=Kr.inherits,y=t.PromiseInspection;f.prototype.data=function(){return this._data},f.prototype.promise=function(){return this._promise},f.prototype.resource=function(){return this.promise().isFulfilled()?this.promise().value():null},f.prototype.tryDispose=function(t){var e=this.resource(),n=this._context;void 0!==n&&n._pushContext();var r=null!==e?this.doDispose(e,t):null;return void 0!==n&&n._popContext(),this._promise._unsetDisposable(),this._data=null,r},f.isDisposer=function(t){return null!=t&&"function"==typeof t.resource&&"function"==typeof t.tryDispose},d(l,f),l.prototype.doDispose=function(t,e){return this.data().call(t,t,e)},t.using=function(){var r=arguments.length;if(r<2)return e("you must pass at least 2 arguments to Promise.using");var o=arguments[r-1];if("function"!=typeof o)return e("fn must be a function\n\n    See http://goo.gl/916lJJ\n");r--;for(var s=new Array(r),a=0;a<r;++a){var l=arguments[a];if(f.isDisposer(l)){var p=l;(l=l.promise())._setDisposable(p);}else{var d=n(l);d instanceof t&&(l=d._then(h,null,null,{resources:s,index:a},void 0));}s[a]=l;}var y=t.settle(s).then(i).then(function(t){y._pushContext();var e;try{e=o.apply(void 0,t);}finally{y._popContext();}return e})._then(u,c,void 0,s,void 0);return s.promise=y,y},t.prototype._setDisposable=function(t){this._bitField=262144|this._bitField,this._disposer=t;},t.prototype._isDisposable=function(){return(262144&this._bitField)>0},t.prototype._getDisposer=function(){return this._disposer},t.prototype._unsetDisposable=function(){this._bitField=-262145&this._bitField,this._disposer=void 0;},t.prototype.disposer=function(t){if("function"==typeof t)return new l(t,this,r());throw new p};},$i=function(t,e,n,r){function i(e,n,i){for(var o=0;o<n.length;++o){i._pushContext();var s=c(n[o])(e);if(i._popContext(),s===u){i._pushContext();var a=t.reject(u.e);return i._popContext(),a}var f=r(s,i);if(f instanceof t)return f}return null}function o(e,r,i,o){(this._promise=new t(n))._captureStackTrace(),this._stack=o,this._generatorFunction=e,this._receiver=r,this._generator=void 0,this._yieldHandlers="function"==typeof i?[i].concat(f):f;}var s=mi.TypeError,a=Kr,u=a.errorObj,c=a.tryCatch,f=[];o.prototype.promise=function(){return this._promise},o.prototype._run=function(){this._generator=this._generatorFunction.call(this._receiver),this._receiver=this._generatorFunction=void 0,this._next(void 0);},o.prototype._continue=function(e){if(e===u)return this._promise._rejectCallback(e.e,!1,!0);var n=e.value;if(!0===e.done)this._promise._resolveCallback(n);else{var o=r(n,this._promise);if(!(o instanceof t)&&null===(o=i(o,this._yieldHandlers,this._promise)))return void this._throw(new s("A value %s was yielded that could not be treated as a promise\n\n    See http://goo.gl/4Y4pDk\n\n".replace("%s",n)+"From coroutine:\n"+this._stack.split("\n").slice(1,-7).join("\n")));o._then(this._next,this._throw,void 0,this,null);}},o.prototype._throw=function(t){this._promise._attachExtraTrace(t),this._promise._pushContext();var e=c(this._generator.throw).call(this._generator,t);this._promise._popContext(),this._continue(e);},o.prototype._next=function(t){this._promise._pushContext();var e=c(this._generator.next).call(this._generator,t);this._promise._popContext(),this._continue(e);},t.coroutine=function(t,e){if("function"!=typeof t)throw new s("generatorFunction must be a function\n\n    See http://goo.gl/6Vqhm0\n");var n=Object(e).yieldHandler,r=o,i=(new Error).stack;return function(){var e=t.apply(this,arguments),o=new r(void 0,void 0,n,i);return o._generator=e,o._next(void 0),o.promise()}},t.coroutine.addYieldHandler=function(t){if("function"!=typeof t)throw new s("fn must be a function\n\n    See http://goo.gl/916lJJ\n");f.push(t);},t.spawn=function(n){if("function"!=typeof n)return e("generatorFunction must be a function\n\n    See http://goo.gl/6Vqhm0\n");var r=new o(n,this),i=r.promise();return r._run(t.spawn),i};},Yi=function(t){function e(t,e){var r=this;if(!i.isArray(t))return n.call(r,t,e);var u=s(e).apply(r._boundValue(),[null].concat(t));u===a&&o.throwLater(u.e);}function n(t,e){var n=this._boundValue(),r=void 0===t?s(e).call(n,null):s(e).call(n,null,t);r===a&&o.throwLater(r.e);}function r(t,e){var n=this;if(!t){var r=n._target()._getCarriedStackTrace();r.cause=t,t=r;}var i=s(e).call(n._boundValue(),t);i===a&&o.throwLater(i.e);}var i=Kr,o=ri,s=i.tryCatch,a=i.errorObj;t.prototype.asCallback=t.prototype.nodeify=function(t,i){if("function"==typeof t){var o=n;void 0!==i&&Object(i).spread&&(o=e),this._then(o,r,void 0,this,t);}return this};},Wi=Object.create;if(Wi){var Vi=Wi(null),Ki=Wi(null);Vi[" size"]=Ki[" size"]=0;}var Qi=function(t){function e(e,n){var r;if(null!=e&&(r=e[n]),"function"!=typeof r){var i="Object "+a.classString(e)+" has no method '"+a.toString(n)+"'";throw new t.TypeError(i)}return r}function n(t){return e(t,this.pop()).apply(t,this)}function r(t){return t[this]}function i(t){var e=+this;return e<0&&(e=Math.max(0,e+t.length)),t[e]}var o,s,a=Kr,u=a.canEvaluate,c=a.isIdentifier,f=function(t){return new Function("ensureMethod","                                    \n        return function(obj) {                                               \n            'use strict'                                                     \n            var len = this.length;                                           \n            ensureMethod(obj, 'methodName');                                 \n            switch(len) {                                                    \n                case 1: return obj.methodName(this[0]);                      \n                case 2: return obj.methodName(this[0], this[1]);             \n                case 3: return obj.methodName(this[0], this[1], this[2]);    \n                case 0: return obj.methodName();                             \n                default:                                                     \n                    return obj.methodName.apply(obj, this);                  \n            }                                                                \n        };                                                                   \n        ".replace(/methodName/g,t))(e)},l=function(t){return new Function("obj","                                             \n        'use strict';                                                        \n        return obj.propertyName;                                             \n        ".replace("propertyName",t))},h=function(t,e,n){var r=n[t];if("function"!=typeof r){if(!c(t))return null;if(r=e(t),n[t]=r,n[" size"]++,n[" size"]>512){for(var i=Object.keys(n),o=0;o<256;++o)delete n[i[o]];n[" size"]=i.length-256;}}return r};o=function(t){return h(t,f,Vi)},s=function(t){return h(t,l,Ki)},t.prototype.call=function(t){for(var e=arguments.length,r=new Array(e-1),i=1;i<e;++i)r[i-1]=arguments[i];if(u){var s=o(t);if(null!==s)return this._then(s,void 0,void 0,r,void 0)}return r.push(t),this._then(n,void 0,void 0,r,void 0)},t.prototype.get=function(t){var e;if("number"==typeof t)e=i;else if(u){var n=s(t);e=null!==n?n:r;}else e=r;return this._then(e,void 0,void 0,t,void 0)};},Ji=function(t,e,n,r){function i(t){for(var e=u.keys(t),n=e.length,r=new Array(2*n),i=0;i<n;++i){var o=e[i];r[i]=t[o],r[i+n]=o;}this.constructor$(r);}function o(e){var o,s=n(e);return a(s)?(o=s instanceof t?s._then(t.props,void 0,void 0,void 0,void 0):new i(s).promise(),s instanceof t&&o._propagateFrom(s,4),o):r("cannot await properties of a non-object\n\n    See http://goo.gl/OsFKC8\n")}var s=Kr,a=s.isObject,u=Ir;s.inherits(i,e),i.prototype._init=function(){this._init$(void 0,-3);},i.prototype._promiseFulfilled=function(t,e){if(this._values[e]=t,++this._totalResolved>=this._length){for(var n={},r=this.length(),i=0,o=this.length();i<o;++i)n[this._values[i+r]]=this._values[i];this._resolve(n);}},i.prototype._promiseProgressed=function(t,e){this._promise._progress({key:this._values[e+this.length()],value:t});},i.prototype.shouldCopyValues=function(){return!1},i.prototype.getActualLength=function(t){return t>>1},t.prototype.props=function(){return o(this)},t.props=function(t){return o(t)};},Gi=function(t,e,n,r){function i(i,a){var u=n(i);if(u instanceof t)return s(u);if(!o(i))return r("expecting an array, a promise or a thenable\n\n    See http://goo.gl/s8MMhc\n");var c=new t(e);void 0!==a&&c._propagateFrom(a,5);for(var f=c._fulfill,l=c._reject,h=0,p=i.length;h<p;++h){var d=i[h];(void 0!==d||h in i)&&t.cast(d)._then(f,l,void 0,c,null);}return c}var o=Kr.isArray,s=function(t){return t.then(function(e){return i(e,t)})};t.race=function(t){return i(t,void 0)},t.prototype.race=function(){return i(this,void 0)};},Xi=function(t,e,n,r,i){function o(e,n,o,a){this.constructor$(e),this._promise._captureStackTrace(),this._preservedValues=a===i?[]:null,this._zerothIsAccum=void 0===o,this._gotAccum=!1,this._reducingIndex=this._zerothIsAccum?1:0,this._valuesPhase=void 0;var f=r(o,this._promise),l=!1,h=f instanceof t;h&&((f=f._target())._isPending()?f._proxyPromiseArray(this,-1):f._isFulfilled()?(o=f._value(),this._gotAccum=!0):(this._reject(f._reason()),l=!0)),h||this._zerothIsAccum||(this._gotAccum=!0);var p=u();this._callback=null===p?n:p.bind(n),this._accum=o,l||c.invoke(s,this,void 0);}function s(){this._init$(void 0,-5);}function a(t,e,r,i){return"function"!=typeof e?n("fn must be a function\n\n    See http://goo.gl/916lJJ\n"):new o(t,e,r,i).promise()}var u=t._getDomain,c=ri,f=Kr,l=f.tryCatch,h=f.errorObj;f.inherits(o,e),o.prototype._init=function(){},o.prototype._resolveEmptyArray=function(){(this._gotAccum||this._zerothIsAccum)&&this._resolve(null!==this._preservedValues?[]:this._accum);},o.prototype._promiseFulfilled=function(e,n){var i=this._values;i[n]=e;var o,s=this.length(),a=this._preservedValues,u=null!==a,c=this._gotAccum,f=this._valuesPhase;if(!f)for(f=this._valuesPhase=new Array(s),o=0;o<s;++o)f[o]=0;if(o=f[n],0===n&&this._zerothIsAccum?(this._accum=e,this._gotAccum=c=!0,f[n]=0===o?1:2):-1===n?(this._accum=e,this._gotAccum=c=!0):0===o?f[n]=1:(f[n]=2,this._accum=e),c){for(var p,d=this._callback,y=this._promise._boundValue(),g=this._reducingIndex;g<s;++g)if(2!==(o=f[g])){if(1!==o)return;if(e=i[g],this._promise._pushContext(),u?(a.push(e),p=l(d).call(y,e,g,s)):p=l(d).call(y,this._accum,e,g,s),this._promise._popContext(),p===h)return this._reject(p.e);var v=r(p,this._promise);if(v instanceof t){if((v=v._target())._isPending())return f[g]=4,v._proxyPromiseArray(this,g);if(!v._isFulfilled())return this._reject(v._reason());p=v._value();}this._reducingIndex=g+1,this._accum=p;}else this._reducingIndex=g+1;this._resolve(u?a:this._accum);}},t.prototype.reduce=function(t,e){return a(this,t,e,null)},t.reduce=function(t,e,n,r){return a(t,e,n,r)};},Zi=function(t,e){function n(t){this.constructor$(t);}var r=t.PromiseInspection;Kr.inherits(n,e),n.prototype._promiseResolved=function(t,e){this._values[t]=e,++this._totalResolved>=this._length&&this._resolve(this._values);},n.prototype._promiseFulfilled=function(t,e){var n=new r;n._bitField=268435456,n._settledValue=t,this._promiseResolved(e,n);},n.prototype._promiseRejected=function(t,e){var n=new r;n._bitField=134217728,n._settledValue=t,this._promiseResolved(e,n);},t.settle=function(t){return new n(t).promise()},t.prototype.settle=function(){return new n(this).promise()};},to=function(t,e,n){function r(t){this.constructor$(t),this._howMany=0,this._unwrap=!1,this._initialized=!1;}function i(t,e){if((0|e)!==e||e<0)return n("expecting a positive integer\n\n    See http://goo.gl/1wAmHx\n");var i=new r(t),o=i.promise();return i.setHowMany(e),i.init(),o}var o=Kr,s=mi.RangeError,a=mi.AggregateError,u=o.isArray;o.inherits(r,e),r.prototype._init=function(){if(this._initialized)if(0!==this._howMany){this._init$(void 0,-5);var t=u(this._values);!this._isResolved()&&t&&this._howMany>this._canPossiblyFulfill()&&this._reject(this._getRangeError(this.length()));}else this._resolve([]);},r.prototype.init=function(){this._initialized=!0,this._init();},r.prototype.setUnwrap=function(){this._unwrap=!0;},r.prototype.howMany=function(){return this._howMany},r.prototype.setHowMany=function(t){this._howMany=t;},r.prototype._promiseFulfilled=function(t){this._addFulfilled(t),this._fulfilled()===this.howMany()&&(this._values.length=this.howMany(),1===this.howMany()&&this._unwrap?this._resolve(this._values[0]):this._resolve(this._values));},r.prototype._promiseRejected=function(t){if(this._addRejected(t),this.howMany()>this._canPossiblyFulfill()){for(var e=new a,n=this.length();n<this._values.length;++n)e.push(this._values[n]);this._reject(e);}},r.prototype._fulfilled=function(){return this._totalResolved},r.prototype._rejected=function(){return this._values.length-this.length()},r.prototype._addRejected=function(t){this._values.push(t);},r.prototype._addFulfilled=function(t){this._values[this._totalResolved++]=t;},r.prototype._canPossiblyFulfill=function(){return this.length()-this._rejected()},r.prototype._getRangeError=function(t){var e="Input array must contain at least "+this._howMany+" items but contains only "+t+" items";return new s(e)},r.prototype._resolveEmptyArray=function(){this._reject(this._getRangeError(0));},t.some=function(t,e){return i(t,e)},t.prototype.some=function(t){return i(this,t)},t._SomePromiseArray=r;},eo=function(t,e){function n(t){return!b.test(t)}function r(t){try{return!0===t.__isPromisified__}catch(t){return!1}}function i(t,e,n){var i=l.getDataPropertyOrDefault(t,e+n,v);return!!i&&r(i)}function o(t,e,n){for(var r=0;r<t.length;r+=2){var i=t[r];if(n.test(i))for(var o=i.replace(n,""),s=0;s<t.length;s+=2)if(t[s]===o)throw new g("Cannot promisify an API that has normal methods with '%s'-suffix\n\n    See http://goo.gl/iWrZbw\n".replace("%s",e))}}function s(t,e,n,s){for(var a=l.inheritedDataKeys(t),u=[],c=0;c<a.length;++c){var f=a[c],h=t[f],p=s===_||_(f,h,t);"function"!=typeof h||r(h)||i(t,f,e)||!s(f,h,t,p)||u.push(f,h);}return o(u,e,n),u}function a(t,e,n,r){for(var i=new RegExp(w(e)+"$"),o=s(t,e,i,n),a=0,u=o.length;a<u;a+=2){var c=o[a],h=o[a+1];t[c+e]=r===j?j(c,f,c,h,e):r(h,function(){return j(c,f,c,h,e)});}return l.toFastProperties(t),t}function u(t,e){return j(t,e,void 0,t)}var c,f={},l=Kr,h=Pi._nodebackForPromise,p=l.withAppended,d=l.maybeWrapAsError,y=l.canEvaluate,g=mi.TypeError,v={__isPromisified__:!0},m=["arity","length","name","arguments","caller","callee","prototype","__isPromisified__"],b=new RegExp("^(?:"+m.join("|")+")$"),_=function(t){return l.isIdentifier(t)&&"_"!==t.charAt(0)&&"constructor"!==t},w=function(t){return t.replace(/([$])/,"\\$")},E=function(t){for(var e=[t],n=Math.max(0,t-1-3),r=t-1;r>=n;--r)e.push(r);for(r=t+1;r<=3;++r)e.push(r);return e},x=function(t){return l.filledRange(t,"_arg","")},A=function(t){return l.filledRange(Math.max(t,3),"_arg","")},F=function(t){return"number"==typeof t.length?Math.max(Math.min(t.length,1024),0):0};c=function(n,r,i,o){function s(t){var e=x(t).join(", "),n=t>0?", ":"";return(c?"ret = callback.call(this, {{args}}, nodeback); break;\n":void 0===r?"ret = callback({{args}}, nodeback); break;\n":"ret = callback.call(receiver, {{args}}, nodeback); break;\n").replace("{{args}}",e).replace(", ",n)}var a=Math.max(0,F(o)-1),u=E(a),c="string"==typeof n||r===f,y="string"==typeof n?"this != null ? this['"+n+"'] : fn":"fn";return new Function("Promise","fn","receiver","withAppended","maybeWrapAsError","nodebackForPromise","tryCatch","errorObj","notEnumerableProp","INTERNAL","'use strict';                            \n        var ret = function (Parameters) {                                    \n            'use strict';                                                    \n            var len = arguments.length;                                      \n            var promise = new Promise(INTERNAL);                             \n            promise._captureStackTrace();                                    \n            var nodeback = nodebackForPromise(promise);                      \n            var ret;                                                         \n            var callback = tryCatch([GetFunctionCode]);                      \n            switch(len) {                                                    \n                [CodeForSwitchCase]                                          \n            }                                                                \n            if (ret === errorObj) {                                          \n                promise._rejectCallback(maybeWrapAsError(ret.e), true, true);\n            }                                                                \n            return promise;                                                  \n        };                                                                   \n        notEnumerableProp(ret, '__isPromisified__', true);                   \n        return ret;                                                          \n        ".replace("Parameters",A(a)).replace("[CodeForSwitchCase]",function(){for(var t="",e=0;e<u.length;++e)t+="case "+u[e]+":"+s(u[e]);return t+="                                                             \n        default:                                                             \n            var args = new Array(len + 1);                                   \n            var i = 0;                                                       \n            for (var i = 0; i < len; ++i) {                                  \n               args[i] = arguments[i];                                       \n            }                                                                \n            args[i] = nodeback;                                              \n            [CodeForCall]                                                    \n            break;                                                           \n        ".replace("[CodeForCall]",c?"ret = callback.apply(this, args);\n":"ret = callback.apply(receiver, args);\n")}()).replace("[GetFunctionCode]",y))(t,o,r,p,d,h,l.tryCatch,l.errorObj,l.notEnumerableProp,e)};var j=y?c:function(n,r,i,o){function s(){var i=r;r===f&&(i=this);var o=new t(e);o._captureStackTrace();var s="string"==typeof u&&this!==a?this[u]:n,c=h(o);try{s.apply(i,p(arguments,c));}catch(t){o._rejectCallback(d(t),!0,!0);}return o}var a=function(){return this}(),u=n;return"string"==typeof u&&(n=o),l.notEnumerableProp(s,"__isPromisified__",!0),s};t.promisify=function(t,e){if("function"!=typeof t)throw new g("fn must be a function\n\n    See http://goo.gl/916lJJ\n");if(r(t))return t;var i=u(t,arguments.length<2?f:e);return l.copyDescriptors(t,i,n),i},t.promisifyAll=function(t,e){if("function"!=typeof t&&"object"!=typeof t)throw new g("the target of promisifyAll must be an object or a function\n\n    See http://goo.gl/9ITlV0\n");var n=(e=Object(e)).suffix;"string"!=typeof n&&(n="Async");var r=e.filter;"function"!=typeof r&&(r=_);var i=e.promisifier;if("function"!=typeof i&&(i=j),!l.isIdentifier(n))throw new RangeError("suffix must be a valid identifier\n\n    See http://goo.gl/8FZo5V\n");for(var o=l.inheritedDataKeys(t),s=0;s<o.length;++s){var u=t[o[s]];"constructor"!==o[s]&&l.isClass(u)&&(a(u.prototype,n,r,i),a(u,n,r,i));}return a(t,n,r,i)};},no=function(t){function e(t){var e=new n(t),r=e.promise();return e.setHowMany(1),e.setUnwrap(),e.init(),r}var n=t._SomePromiseArray;t.any=function(t){return e(t)},t.prototype.any=function(){return e(this)};},ro=function(t,e){var n=t.reduce;t.prototype.each=function(t){return n(this,t,null,e)},t.each=function(t,r){return n(t,r,null,e)};},io=function(t,e){function n(t){var e=this;return e instanceof Number&&(e=+e),clearTimeout(e),t}function r(t){var e=this;throw e instanceof Number&&(e=+e),clearTimeout(e),t}var i=Kr,o=t.TimeoutError,s=function(t,e){if(t.isPending()){"string"!=typeof e&&(e="operation timed out");var n=new o(e);i.markAsOriginatingFromRejection(n),t._attachExtraTrace(n),t._cancel(n);}},a=function(t){return u(+this).thenReturn(t)},u=t.delay=function(n,r){if(void 0===r){r=n,n=void 0;var i=new t(e);return setTimeout(function(){i._fulfill();},r),i}return r=+r,t.resolve(n)._then(a,null,null,r,void 0)};t.prototype.delay=function(t){return u(this,t)},t.prototype.timeout=function(t,e){t=+t;var i=this.then().cancellable();i._cancellationParent=this;var o=setTimeout(function(){s(i,e);},t);return i._then(n,r,void 0,o,void 0)};},oo=function(t,e){var n=t.map;t.prototype.filter=function(t,r){return n(this,t,r,e)},t.filter=function(t,r,i){return n(t,r,i,e)};},so=function(){function t(e){if("function"!=typeof e)throw new c("the promise constructor requires a resolver function\n\n    See http://goo.gl/EC22Yn\n");if(this.constructor!==t)throw new c("the promise constructor cannot be invoked directly\n\n    See http://goo.gl/KsIlge\n");this._bitField=0,this._fulfillmentHandler0=void 0,this._rejectionHandler0=void 0,this._progressHandler0=void 0,this._promise0=void 0,this._receiver0=void 0,this._settledValue=void 0,e!==f&&this._resolveFromResolver(e);}function e(e){var n=new t(f);n._fulfillmentHandler0=e,n._rejectionHandler0=e,n._progressHandler0=e,n._promise0=e,n._receiver0=e,n._settledValue=e;}var n,r=function(){return new c("circular promise resolution chain\n\n    See http://goo.gl/LhFpo0\n")},i=function(){return new t.PromiseInspection(this._target())},o=function(e){return t.reject(new c(e))},s=Kr;n=s.isNode?function(){var t=zn.domain;return void 0===t&&(t=null),t}:function(){return null},s.notEnumerableProp(t,"_getDomain",n);var a=ri,u=mi,c=t.TypeError=u.TypeError;t.RangeError=u.RangeError,t.CancellationError=u.CancellationError,t.TimeoutError=u.TimeoutError,t.OperationalError=u.OperationalError,t.RejectionError=u.OperationalError,t.AggregateError=u.AggregateError;var f=function(){},l={},h={e:null},p=bi(t,f),d=_i(t,f,p,o),y=wi(),g=Ei(t,y),v=xi(t,y,g),m=Ai(h),b=Pi,_=b._nodebackForPromise,w=s.errorObj,E=s.tryCatch;return t.prototype.toString=function(){return"[object Promise]"},t.prototype.caught=t.prototype.catch=function(e){var n=arguments.length;if(n>1){var r,i=new Array(n-1),o=0;for(r=0;r<n-1;++r){var s=arguments[r];if("function"!=typeof s)return t.reject(new c("Catch filter must inherit from Error or be a simple predicate function\n\n    See http://goo.gl/o84o68\n"));i[o++]=s;}i.length=o,e=arguments[r];var a=new m(i,e,this);return this._then(void 0,a.doFilter,void 0,a,void 0)}return this._then(void 0,e,void 0,void 0,void 0)},t.prototype.reflect=function(){return this._then(i,i,void 0,this,void 0)},t.prototype.then=function(t,e,n){if(g()&&arguments.length>0&&"function"!=typeof t&&"function"!=typeof e){var r=".then() only accepts functions but was passed: "+s.classString(t);arguments.length>1&&(r+=", "+s.classString(e)),this._warn(r);}return this._then(t,e,n,void 0,void 0)},t.prototype.done=function(t,e,n){this._then(t,e,n,void 0,void 0)._setIsFinal();},t.prototype.spread=function(t,e){return this.all()._then(t,e,void 0,l,void 0)},t.prototype.isCancellable=function(){return!this.isResolved()&&this._cancellable()},t.prototype.toJSON=function(){var t={isFulfilled:!1,isRejected:!1,fulfillmentValue:void 0,rejectionReason:void 0};return this.isFulfilled()?(t.fulfillmentValue=this.value(),t.isFulfilled=!0):this.isRejected()&&(t.rejectionReason=this.reason(),t.isRejected=!0),t},t.prototype.all=function(){return new d(this).promise()},t.prototype.error=function(t){return this.caught(s.originatesFromRejection,t)},t.is=function(e){return e instanceof t},t.fromNode=function(e){var n=new t(f),r=E(e)(_(n));return r===w&&n._rejectCallback(r.e,!0,!0),n},t.all=function(t){return new d(t).promise()},t.defer=t.pending=function(){var e=new t(f);return new b(e)},t.cast=function(e){var n=p(e);if(!(n instanceof t)){var r=n;(n=new t(f))._fulfillUnchecked(r);}return n},t.resolve=t.fulfilled=t.cast,t.reject=t.rejected=function(e){var n=new t(f);return n._captureStackTrace(),n._rejectCallback(e,!0),n},t.setScheduler=function(t){if("function"!=typeof t)throw new c("fn must be a function\n\n    See http://goo.gl/916lJJ\n");var e=a._schedule;return a._schedule=t,e},t.prototype._then=function(e,r,i,o,s){var u=void 0!==s,c=u?s:new t(f);u||(c._propagateFrom(this,5),c._captureStackTrace());var l=this._target();l!==this&&(void 0===o&&(o=this._boundTo),u||c._setIsMigrated());var h=l._addCallbacks(e,r,i,c,o,n());return l._isResolved()&&!l._isSettlePromisesQueued()&&a.invoke(l._settlePromiseAtPostResolution,l,h),c},t.prototype._settlePromiseAtPostResolution=function(t){this._isRejectionUnhandled()&&this._unsetRejectionIsUnhandled(),this._settlePromiseAt(t);},t.prototype._length=function(){return 131071&this._bitField},t.prototype._isFollowingOrFulfilledOrRejected=function(){return(939524096&this._bitField)>0},t.prototype._isFollowing=function(){return 536870912==(536870912&this._bitField)},t.prototype._setLength=function(t){this._bitField=-131072&this._bitField|131071&t;},t.prototype._setFulfilled=function(){this._bitField=268435456|this._bitField;},t.prototype._setRejected=function(){this._bitField=134217728|this._bitField;},t.prototype._setFollowing=function(){this._bitField=536870912|this._bitField;},t.prototype._setIsFinal=function(){this._bitField=33554432|this._bitField;},t.prototype._isFinal=function(){return(33554432&this._bitField)>0},t.prototype._cancellable=function(){return(67108864&this._bitField)>0},t.prototype._setCancellable=function(){this._bitField=67108864|this._bitField;},t.prototype._unsetCancellable=function(){this._bitField=-67108865&this._bitField;},t.prototype._setIsMigrated=function(){this._bitField=4194304|this._bitField;},t.prototype._unsetIsMigrated=function(){this._bitField=-4194305&this._bitField;},t.prototype._isMigrated=function(){return(4194304&this._bitField)>0},t.prototype._receiverAt=function(t){var e=0===t?this._receiver0:this[5*t-5+4];return void 0===e&&this._isBound()?this._boundValue():e},t.prototype._promiseAt=function(t){return 0===t?this._promise0:this[5*t-5+3]},t.prototype._fulfillmentHandlerAt=function(t){return 0===t?this._fulfillmentHandler0:this[5*t-5+0]},t.prototype._rejectionHandlerAt=function(t){return 0===t?this._rejectionHandler0:this[5*t-5+1]},t.prototype._boundValue=function(){var e=this._boundTo;return void 0!==e&&e instanceof t?e.isFulfilled()?e.value():void 0:e},t.prototype._migrateCallbacks=function(e,n){var r=e._fulfillmentHandlerAt(n),i=e._rejectionHandlerAt(n),o=e._progressHandlerAt(n),s=e._promiseAt(n),a=e._receiverAt(n);s instanceof t&&s._setIsMigrated(),this._addCallbacks(r,i,o,s,a,null);},t.prototype._addCallbacks=function(t,e,n,r,i,o){var s=this._length();if(s>=131066&&(s=0,this._setLength(0)),0===s)this._promise0=r,void 0!==i&&(this._receiver0=i),"function"!=typeof t||this._isCarryingStackTrace()||(this._fulfillmentHandler0=null===o?t:o.bind(t)),"function"==typeof e&&(this._rejectionHandler0=null===o?e:o.bind(e)),"function"==typeof n&&(this._progressHandler0=null===o?n:o.bind(n));else{var a=5*s-5;this[a+3]=r,this[a+4]=i,"function"==typeof t&&(this[a+0]=null===o?t:o.bind(t)),"function"==typeof e&&(this[a+1]=null===o?e:o.bind(e)),"function"==typeof n&&(this[a+2]=null===o?n:o.bind(n));}return this._setLength(s+1),s},t.prototype._setProxyHandlers=function(t,e){var n=this._length();if(n>=131066&&(n=0,this._setLength(0)),0===n)this._promise0=e,this._receiver0=t;else{var r=5*n-5;this[r+3]=e,this[r+4]=t;}this._setLength(n+1);},t.prototype._proxyPromiseArray=function(t,e){this._setProxyHandlers(t,e);},t.prototype._resolveCallback=function(e,n){if(!this._isFollowingOrFulfilledOrRejected()){if(e===this)return this._rejectCallback(r(),!1,!0);var i=p(e,this);if(!(i instanceof t))return this._fulfill(e);var o=1|(n?4:0);this._propagateFrom(i,o);var s=i._target();if(s._isPending()){for(var a=this._length(),u=0;u<a;++u)s._migrateCallbacks(this,u);this._setFollowing(),this._setLength(0),this._setFollowee(s);}else s._isFulfilled()?this._fulfillUnchecked(s._value()):this._rejectUnchecked(s._reason(),s._getCarriedStackTrace());}},t.prototype._rejectCallback=function(t,e,n){n||s.markAsOriginatingFromRejection(t);var r=s.ensureErrorObject(t),i=r===t;this._attachExtraTrace(r,!!e&&i),this._reject(t,i?void 0:r);},t.prototype._resolveFromResolver=function(t){var e=this;this._captureStackTrace(),this._pushContext();var n=!0,r=E(t)(function(t){null!==e&&(e._resolveCallback(t),e=null);},function(t){null!==e&&(e._rejectCallback(t,n),e=null);});n=!1,this._popContext(),void 0!==r&&r===w&&null!==e&&(e._rejectCallback(r.e,!0,!0),e=null);},t.prototype._settlePromiseFromHandler=function(t,e,n,i){if(!i._isRejected()){i._pushContext();var o;if(o=e!==l||this._isRejected()?E(t).call(e,n):E(t).apply(this._boundValue(),n),i._popContext(),o===w||o===i||o===h){var s=o===i?r():o.e;i._rejectCallback(s,!1,!0);}else i._resolveCallback(o);}},t.prototype._target=function(){for(var t=this;t._isFollowing();)t=t._followee();return t},t.prototype._followee=function(){return this._rejectionHandler0},t.prototype._setFollowee=function(t){this._rejectionHandler0=t;},t.prototype._cleanValues=function(){this._cancellable()&&(this._cancellationParent=void 0);},t.prototype._propagateFrom=function(t,e){(1&e)>0&&t._cancellable()&&(this._setCancellable(),this._cancellationParent=t),(4&e)>0&&t._isBound()&&this._setBoundTo(t._boundTo);},t.prototype._fulfill=function(t){this._isFollowingOrFulfilledOrRejected()||this._fulfillUnchecked(t);},t.prototype._reject=function(t,e){this._isFollowingOrFulfilledOrRejected()||this._rejectUnchecked(t,e);},t.prototype._settlePromiseAt=function(e){var n=this._promiseAt(e),r=n instanceof t;if(r&&n._isMigrated())return n._unsetIsMigrated(),a.invoke(this._settlePromiseAt,this,e);var i=this._isFulfilled()?this._fulfillmentHandlerAt(e):this._rejectionHandlerAt(e),o=this._isCarryingStackTrace()?this._getCarriedStackTrace():void 0,s=this._settledValue,u=this._receiverAt(e);this._clearCallbackDataAtIndex(e),"function"==typeof i?r?this._settlePromiseFromHandler(i,u,s,n):i.call(u,s,n):u instanceof d?u._isResolved()||(this._isFulfilled()?u._promiseFulfilled(s,n):u._promiseRejected(s,n)):r&&(this._isFulfilled()?n._fulfill(s):n._reject(s,o)),e>=4&&4==(31&e)&&a.invokeLater(this._setLength,this,0);},t.prototype._clearCallbackDataAtIndex=function(t){if(0===t)this._isCarryingStackTrace()||(this._fulfillmentHandler0=void 0),this._rejectionHandler0=this._progressHandler0=this._receiver0=this._promise0=void 0;else{var e=5*t-5;this[e+3]=this[e+4]=this[e+0]=this[e+1]=this[e+2]=void 0;}},t.prototype._isSettlePromisesQueued=function(){return-1073741824==(-1073741824&this._bitField)},t.prototype._setSettlePromisesQueued=function(){this._bitField=-1073741824|this._bitField;},t.prototype._unsetSettlePromisesQueued=function(){this._bitField=1073741823&this._bitField;},t.prototype._queueSettlePromises=function(){a.settlePromises(this),this._setSettlePromisesQueued();},t.prototype._fulfillUnchecked=function(t){if(t===this){var e=r();return this._attachExtraTrace(e),this._rejectUnchecked(e,void 0)}this._setFulfilled(),this._settledValue=t,this._cleanValues(),this._length()>0&&this._queueSettlePromises();},t.prototype._rejectUncheckedCheckError=function(t){var e=s.ensureErrorObject(t);this._rejectUnchecked(t,e===t?void 0:e);},t.prototype._rejectUnchecked=function(t,e){if(t===this){var n=r();return this._attachExtraTrace(n),this._rejectUnchecked(n)}this._setRejected(),this._settledValue=t,this._cleanValues(),this._isFinal()?a.throwLater(function(t){throw"stack"in t&&a.invokeFirst(y.unhandledRejection,void 0,t),t},void 0===e?t:e):(void 0!==e&&e!==t&&this._setCarriedStackTrace(e),this._length()>0?this._queueSettlePromises():this._ensurePossibleRejectionHandled());},t.prototype._settlePromises=function(){this._unsetSettlePromisesQueued();for(var t=this._length(),e=0;e<t;e++)this._settlePromiseAt(e);},s.notEnumerableProp(t,"_makeSelfResolutionError",r),Di(t,d),Mi(t,f,p,o),Ri(t,f,p),Bi(t,h,p),Li(t),Ni(t),Ui(t,d,p,f),t.Promise=t,zi(t,d,o,p,f),qi(t),Hi(t,o,p,v),$i(t,o,f,p),Yi(t),Qi(t),Ji(t,d,p,o),Gi(t,f,p,o),Xi(t,d,o,p,f),Zi(t,d),to(t,d,o),eo(t,f),no(t),ro(t,f),io(t,f),oo(t,f),s.toFastProperties(t),s.toFastProperties(t.prototype),e({a:1}),e({b:2}),e({c:3}),e(1),e(function(){}),e(void 0),e(!1),e(new t(f)),y.setBounds(a.firstLineError,s.lastLineError),t},ao;"undefined"!=typeof Promise&&(ao=Promise);var uo=so();uo.noConflict=yt;var co=uo,fo={queue:[],drain:function(){this.queue.forEach(function(t){t();}),this.queue=[];}},lo=co.setScheduler(function(t){fo.queue.push(t),lo(function(){fo.drain();});});co.prototype._notifyUnhandledRejection=function(){var t=this;lo(function(){if(t._isRejectionUnhandled()){if(!fo.onUnhandledRejection)throw t.reason();fo.onUnhandledRejection(t.reason());}});};var ho=fo,po=!1;"undefined"!=typeof window&&void 0!==window.location&&(po=!!window.location.search.match(/[?&]full-trace=true(?:$|&)/)),void 0!==zn&&zn.env&&zn.env.UNEXPECTED_FULL_TRACE&&(co.longStackTraces(),po=!0);var yo=po,go=function(t){if(!t||"function"!=typeof t.then)return t;if(!t.isRejected)return t;if(t.isFulfilled())return t;if(t.isRejected())throw t.caught(function(){}),t.reason();var e,n=function(){},r=function(){},i=!1;if(t.then(function(e){i=!0,n(t);},function(t){i=!0,e=t,r(t);}),ho.drain(),i&&e)throw e._isUnexpected&&Error.captureStackTrace&&Error.captureStackTrace(e),e;return i?t:(t._captureStackTrace&&!yo&&t._captureStackTrace(!0),new co(function(t,e){n=t,r=e;}))},vo=gt,mo="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t};["all","any","settle"].forEach(function(t){vt[t]=function(e){var n=co[t](bt(e));return"settle"===t?n.then(function(t){return t.forEach(function(t){t.isRejected()&&vo(t.reason());}),t}):n};}),Object.keys(co).forEach(function(t){/^_|^on|^setScheduler|ongStackTraces/.test(t)||"function"!=typeof co[t]||void 0!==vt[t]||(vt[t]=co[t]);});var bo=vt,_o=_t,wo=function(t){return t&&"function"==typeof t.then&&"function"==typeof t.isPending&&t.isPending()},Eo=3,xo="undefined"!=typeof window&&void 0!==window.location&&window.location.search.match(/[?&]depth=(\d+)(?:$|&)/);xo?Eo=parseInt(xo[1],10):void 0!==zn&&zn.env.UNEXPECTED_DEPTH&&(Eo=parseInt(zn.env.UNEXPECTED_DEPTH,10));var Ao=Eo,Fo=function(t){return t&&(t.isMagicPen?t.diff=t:(t.diff.inline=t.inline,(t=t.diff).diff=t)),t},jo=["message","line","sourceId","sourceURL","stack","stackArray"].reduce(function(t,e){return t[e]=!0,t},{});wt.prototype=Object.create(Error.prototype),wt.prototype.useFullStackTrace=yo;var ko="You must either provide a format or a magicpen instance";wt.prototype.outputFromOptions=function(t){if(!t)throw new Error(ko);if("string"==typeof t)return this.expect.createOutput(t);if(t.isMagicPen)return t.clone();if(t.output)return t.output.clone();if(t.format)return this.expect.createOutput(t.format);throw new Error(ko)},wt.prototype._isUnexpected=!0,wt.prototype.isUnexpected=!0,wt.prototype.buildDiff=function(t){var e=this.outputFromOptions(t),n=this.expect;return this.createDiff&&Fo(this.createDiff(e,function(t,r){return n.diff(t,r,e.clone())},function(t,n){return e.clone().appendInspected(t,(n||Ao)-1)},function(t,e){return n.equal(t,e)}))},wt.prototype.getDefaultErrorMessage=function(t){var e=this.outputFromOptions(t);this.expect.testDescription?e.append(this.expect.standardErrorMessage(e.clone(),t)):"function"==typeof this.output&&this.output.call(e,e);for(var n=this;!n.createDiff&&n.parent;)n=n.parent;if(n&&n.createDiff){var r=n.buildDiff(t);r&&e.nl(2).append(r);}return e},wt.prototype.getNestedErrorMessage=function(t){var e=this.outputFromOptions(t);this.expect.testDescription?e.append(this.expect.standardErrorMessage(e.clone(),t)):"function"==typeof this.output&&this.output.call(e,e);for(var n=this.parent;"bubble"===n.getErrorMode();)n=n.parent;return"string"==typeof t?t={format:t}:t&&t.isMagicPen&&(t={output:t}),e.nl().indentLines().i().block(n.getErrorMessage(dn.extend({},t||{},{compact:this.expect.subject===n.expect.subject}))),e},wt.prototype.getDefaultOrNestedMessage=function(t){return this.hasDiff()?this.getDefaultErrorMessage(t):this.getNestedErrorMessage(t)},wt.prototype.hasDiff=function(){return!!this.getDiffMethod()},wt.prototype.getDiffMethod=function(){for(var t=this;!t.createDiff&&t.parent;)t=t.parent;return t&&t.createDiff||null},wt.prototype.getDiff=function(t){for(var e=this;!e.createDiff&&e.parent;)e=e.parent;return e&&e.buildDiff(t)},wt.prototype.getDiffMessage=function(t){var e=this.outputFromOptions(t),n=this.getDiff(t);return n?e.append(n):this.expect.testDescription?e.append(this.expect.standardErrorMessage(e.clone(),t)):"function"==typeof this.output&&this.output.call(e,e),e},wt.prototype.getErrorMode=function(){if(this.parent)return this.errorMode;switch(this.errorMode){case"default":case"bubbleThrough":return this.errorMode;default:return"default"}},wt.prototype.getErrorMessage=function(t){for(var e=this.parent;e&&"bubbleThrough"!==e.getErrorMode();)e=e.parent;if(e)return e.getErrorMessage(t);var n=this.getErrorMode();switch(n){case"nested":return this.getNestedErrorMessage(t);case"default":case"bubbleThrough":return this.getDefaultErrorMessage(t);case"bubble":return this.parent.getErrorMessage(t);case"diff":return this.getDiffMessage(t);case"defaultOrNested":return this.getDefaultOrNestedMessage(t);default:throw new Error("Unknown error mode: '"+n+"'")}},wt.prototype.serializeMessage=function(t){if(!this._hasSerializedErrorMessage){var e="html"===t;if(e&&("htmlMessage"in this||(this.htmlMessage=this.getErrorMessage({format:"html"}).toString())),this.message="\n"+this.getErrorMessage({format:e?"text":t}).toString()+"\n",this.originalError&&this.originalError instanceof Error&&"string"==typeof this.originalError.stack){var n=this.originalError.stack.indexOf(this.originalError.message);this.stack=-1===n?this.message+"\n"+this.originalError.stack:this.message+this.originalError.stack.substr(n+this.originalError.message.length);}else/^(Unexpected)?Error:?\n/.test(this.stack)&&(this.stack=this.stack.replace(/^(Unexpected)?Error:?\n/,this.message));if(this.stack&&!this.useFullStackTrace){var r=[],i=!1,o=this.stack.split(/\n/),s=Et(o);if(o.forEach(function(t,e){s<=e&&/node_modules\/unexpected(?:-[^\/]+)?\//.test(t)?i=!0:r.push(t);}),i){var a=/^(\s*)/.exec(o[o.length-1])[1];"html"===t?r.push(a+"set the query parameter full-trace=true to see the full stack trace"):r.push(a+"set UNEXPECTED_FULL_TRACE=true to see the full stack trace");}this.stack=r.join("\n");}this._hasSerializedErrorMessage=!0;}},wt.prototype.clone=function(){var t=this,e=new wt(this.expect);return Object.keys(t).forEach(function(n){jo[n]||(e[n]=t[n]);}),e},wt.prototype.getLabel=function(){for(var t=this;t&&!t.label;)t=t.parent;return t&&t.label||null},wt.prototype.getParents=function(){for(var t=[],e=this.parent;e;)t.push(e),e=e.parent;return t},wt.prototype.getAllErrors=function(){var t=this.getParents();return t.unshift(this),t},Object.__defineGetter__&&Object.defineProperty(wt.prototype,"htmlMessage",{enumerable:!0,get:function(){return this.getErrorMessage({format:"html"}).toString()}});var Co=wt,So="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},To=[],Oo=!1,Po=null;"object"===("undefined"==typeof jasmine?"undefined":So(jasmine))&&jasmine.getEnv().addReporter({specStarted:function(t){Po=t;},specDone:function(t){Po=null;}}),At();var Do=function(t){To.push(t),At();},Mo="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},Ro=function(t){var e={promise:bo,errorMode:"default",equal:t.equal,inspect:t.inspect,createOutput:t.createOutput.bind(t),findTypeOf:t.findTypeOf.bind(t),findTypeOfWithParentType:t.findTypeOfWithParentType.bind(t),findCommonType:t.findCommonType.bind(t),it:function(){for(var e=arguments.length,n=new Array(e),r=0;r<e;r+=1)n[r]=arguments[r];return"string"==typeof n[0]&&(n[0]=dn.forwardFlags(n[0],this.flags)),t.it.apply(t,n)},diff:t.diff,getType:t.getType,output:t.output,outputFormat:t.outputFormat.bind(t),format:t.format,withError:t.withError,fail:function(){var t=arguments,e=this.context.expect;this.callInNestedContext(function(){e.fail.apply(e,t);});},standardErrorMessage:function(t,e){var n=this;return e="object"===(void 0===e?"undefined":Mo(e))?e:{},"omitSubject"in t&&(e.subject=this.subject),e&&e.compact&&(e.compactSubject=function(t){t.jsFunctionName(n.subjectType.name);}),un(t,n.subjectOutput,n.testDescription,n.argsOutput,e)},callInNestedContext:function(t){var e=this;try{var n=go(t());return wo(n)?n=n.then(void 0,function(t){if(t&&t._isUnexpected){var n=new Co(e,t);throw n.originalError=t.originalError,n}throw t}):n&&"function"==typeof n.then||(n=bo.resolve(n)),_o(n,e.execute,e.subject)}catch(t){if(t&&t._isUnexpected){var r=new Co(e,t);throw r.originalError=t.originalError,r}throw t}},shift:function(t,e){if(arguments.length<=1){0===arguments.length&&(t=this.subject),e=-1;for(var n=0;n<this.assertionRule.args.length;n+=1){var r=this.assertionRule.args[n].type;if(r.is("assertion")||r.is("expect.it")){e=n;break}}}else 3===arguments.length&&(t=arguments[1],e=arguments[2]);if(-1!==e){var i=this.args.slice(0,e),o=this.args.slice(e),s=this.findTypeOf(o[0]);if(arguments.length>1&&(this.argsOutput=function(t){i.forEach(function(e,n){0<n&&t.text(", "),t.appendInspected(e);}),i.length>0&&t.sp(),s.is("string")?t.error(o[0]):o.length>0&&t.appendInspected(o[0]),o.length>1&&t.sp(),o.slice(1).forEach(function(e,n){0<n&&t.text(", "),t.appendInspected(e);});}),s.is("expect.it")){var a=this;return this.withError(function(){return o[0](t)},function(t){a.fail(t);})}return s.is("string")?this.execute.apply(this.execute,[t].concat(o)):t}return t},_getSubjectType:function(){return this.findTypeOfWithParentType(this.subject,this.assertionRule.subject.type)},_getArgTypes:function(t){var e=this.assertionRule.args.length-1;return this.args.map(function(t,n){return this.findTypeOfWithParentType(t,this.assertionRule.args[Math.min(n,e)].type)},this)},_getAssertionIndices:function(){if(!this._assertionIndices){var e=[],n=this.args,r=this.assertionRule,i=0;t:for(;;){if(r.args.length>1&&Ft(r.args[r.args.length-2])){e.push(i+r.args.length-2);var o=kt(n[i+r.args.length-2],t);if(o)for(var s=0;s<o.length;s+=1)if(o[s].args.some(Ft)){i+=r.args.length-1,r=o[s];continue t}}break}this._assertionIndices=e;}return this._assertionIndices}};return Object.__defineGetter__&&(Object.defineProperty(e,"subjectType",{enumerable:!0,get:function(){return this.assertionRule&&this._getSubjectType()}}),Object.defineProperty(e,"argTypes",{enumerable:!0,get:function(){return this.assertionRule&&this._getArgTypes()}})),dn.setPrototypeOfOrExtend(e,Function.prototype),e},Bo="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},Io=dn.extend;St.prototype.child=function(){var t=Object.create(this);return t.level++,t};var Lo={_unexpectedType:!0,name:"any",level:0,identify:function(){return!0},equal:dn.objectIs,inspect:function(t,e,n){return n&&n.isMagicPen?n.text(t):"type: "+this.name},diff:function(t,e,n,r,i){return null},typeEqualityCache:{},is:function(t){var e;e="string"==typeof t?t:t.name;var n=this.typeEqualityCache[e];if(void 0!==n)return n;var r=!1;return this.name===e?r=!0:this.baseType&&(r=this.baseType.is(e)),this.typeEqualityCache[e]=r,r}},No={};Tt.prototype.it=function(){return Mt(this,[arguments])},Tt.prototype.equal=function(t,e,n,r){var i=this;if((n="number"==typeof n?n:100)<=0){if(-1!==(r=r||[]).indexOf(t))throw new Error("Cannot compare circular structures");r.push(t);}return this.findCommonType(t,e).equal(t,e,function(t,e){return i.equal(t,e,n-1,r)})},Tt.prototype.inspect=function(t,e,n){function r(t,e,n){var s=o.findTypeOf(t);return e<=0&&s.is("object")&&!s.is("expect.it")?n.text("..."):-1!==(i=i||[]).indexOf(t)?n.text("[Circular]"):s.inspect(t,e,n,function(o,s){return n=n.clone(),i.push(t),void 0===s&&(s=e-1),n=r(o,s,n)||n,i.pop(),n})}var i=[],o=this,s="string"==typeof n?this.createOutput(n):n;return s=s||this.createOutput(),r(t,"number"==typeof e?e:Ao,s)||s},Tt.prototype.expandTypeAlternations=function(t){function e(t,r){if(r===t.length)return[];var i=[];return t[r].forEach(function(o){var s=e(t,r+1);s.length?s.forEach(function(t){i.push([o].concat(t));}):o.type.is("assertion")?(i.push([{type:o.type,minimum:1,maximum:1},{type:n.getType("any"),minimum:0,maximum:1/0}]),i.push([{type:n.getType("expect.it"),minimum:1,maximum:1}]),0===o.minimum&&i.push([])):i.push([o]);}),i}var n=this,r=[];return t.subject.forEach(function(n){t.args.length?e(t.args,0).forEach(function(e){r.push(Io({},t,{subject:n,args:e}));}):r.push(Io({},t,{subject:n,args:[]}));}),r},Tt.prototype.parseAssertion=function(t){function e(e){return e.split("|").map(function(e){var n=e.match(/^([a-z_](?:|[a-z0-9_.-]*[_a-z0-9]))([+*?]|)$/i);if(!n)throw new SyntaxError("Cannot parse type declaration:"+e);var i=r.getType(n[1]);if(!i)throw new Error("Unknown type: "+n[1]+" in "+t);var o=n[2];return{minimum:o&&"+"!==o?0:1,maximum:"*"===o||"+"===o?1/0:1,type:i}})}function n(t){return t.some(function(t){return 1!==t.minimum||1!==t.maximum})}var r=this,i=[],o=0;t.replace(/\s*<((?:[a-z_](?:|[a-z0-9_.-]*[_a-z0-9])[?*+]?)(?:\|(?:[a-z_](?:|[a-z0-9_.-]*[_a-z0-9])[?*+]?))*)>|\s*([^<]+)/gi,function(n,r,s,a){if(a!==o)throw new SyntaxError("Cannot parse token at index "+o+" in "+t);r?i.push(e(r)):i.push(s.trim()),o+=n.length;});var s;if(s=1===i.length&&"string"==typeof i[0]?{subject:e("any"),assertion:i[0],args:[e("any*")]}:{subject:i[0],assertion:i[1],args:i.slice(2)},!Array.isArray(s.subject))throw new SyntaxError("Missing subject type in "+t);if("string"!=typeof s.assertion)throw new SyntaxError("Missing assertion in "+t);if(n(s.subject))throw new SyntaxError("The subject type cannot have varargs: "+t);if(s.args.some(function(t){return"string"==typeof t}))throw new SyntaxError("Only one assertion string is supported (see #225)");if(s.args.slice(0,-1).some(n))throw new SyntaxError("Only the last argument type can have varargs: "+t);if([s.subject].concat(s.args.slice(0,-1)).some(function(t){return t.some(function(t){return t.type.is("assertion")})}))throw new SyntaxError("Only the last argument type can be <assertion>: "+t);var a=s.args[s.args.length-1]||[],u=a.filter(function(t){return t.type.is("assertion")});if(u.length>0&&a.length>1)throw new SyntaxError("<assertion> cannot be alternated with other types: "+t);if(u.some(function(t){return 1!==t.maximum}))throw new SyntaxError("<assertion+> and <assertion*> are not allowed: "+t);return this.expandTypeAlternations(s)};var Uo=/(\{(?:\d+)\})/g,zo=/\{(\d+)\}/;Tt.prototype.fail=function(t){if(t instanceof Co)throw t._hasSerializedErrorMessage=!1,t;if(dn.isError(t))throw t;var e=new Co(this.expect);if("function"==typeof t)e.errorMode="bubble",e.output=t;else if(t&&"object"===(void 0===t?"undefined":Bo(t))){void 0!==t.message&&(e.errorMode="bubble"),e.output=function(e){void 0!==t.message?t.message.isMagicPen?e.append(t.message):"function"==typeof t.message?t.message.call(e,e):e.text(String(t.message)):e.error("Explicit failure");};var n=this.expect;Object.keys(t).forEach(function(r){var i=t[r];"diff"===r?"function"==typeof i&&this.parent?e.createDiff=function(t,e,r,o){var s=n.createOutput(t.format);return s.inline=t.inline,s.output=t.output,i(s,function(t,e){return n.diff(t,e,s.clone())},function(t,e){return s.clone().appendInspected(t,(e||Ao)-1)},function(t,e){return n.equal(t,e)})}:e.createDiff=i:"message"!==r&&(e[r]=i);},this);}else{var r;if(arguments.length>0){r=new Array(arguments.length-1);for(var i=1;i<arguments.length;i+=1)r[i-1]=arguments[i];}e.errorMode="bubble",e.output=function(e){(t?String(t):"Explicit failure").split(Uo).forEach(function(t){var n=zo.exec(t);if(n){var i=n[1];if(i in r){var o=r[i];o&&o.isMagicPen?e.append(o):e.appendInspected(o);}else e.text(n[0]);}else e.error(t);});};}throw e},Tt.prototype.addAssertion=function(t,e,n){var r;if(r="object"===(void 0===n?"undefined":Bo(n))?3:2,arguments.length>r||"function"!=typeof e||"string"!=typeof t&&!Array.isArray(t)){var i="Syntax: expect.addAssertion(<string|array[string]>, function (expect, subject, ...) { ... });";throw"string"!=typeof e&&!Array.isArray(e)||"function"!=typeof arguments[2]||(i+="\nAs of Unexpected 10, the syntax for adding assertions that apply only to specific\ntypes has changed. See http://unexpected.js.org/api/addAssertion/"),new Error(i)}var o=Array.isArray(t)?t:[t];o.forEach(function(t){if("string"!=typeof t||""===t)throw new Error("Assertion patterns must be a non-empty string");if(t!==t.trim())throw new Error("Assertion patterns can't start or end with whitespace:\n\n    "+JSON.stringify(t))});var s=this,a=this.assertions,u={},c=[],f=0;if(o.forEach(function(t){s.parseAssertion(t).forEach(function(r){zt(r.assertion),qo(r.assertion).forEach(function(i){Object.keys(i.flags).forEach(function(t){u[t]=!1;}),f=Math.max(f,r.args.reduce(function(t,e){return t+(null===e.maximum?1/0:e.maximum)},0)),c.push({handler:e,alternations:i.alternations,flags:i.flags,subject:r.subject,args:r.args,testDescriptionString:i.text,declaration:t,unexpected:n});});});}),e.length-2>f)throw new Error("The provided assertion handler takes "+(e.length-2)+" parameters, but the type signature specifies a maximum of "+f+":\n\n    "+JSON.stringify(o));return c.forEach(function(t){t.flags=Io({},u,t.flags);var e=a[t.testDescriptionString];if(t.specificity=Bt(t),e){for(var n=0;n<e.length&&Rt(t.specificity,e[n].specificity)>0;)n+=1;e.splice(n,0,t);}else a[t.testDescriptionString]=[t];}),this.expect},Tt.prototype.addType=function(t,e){var n,r=this;if("string"!=typeof t.name||!/^[a-z_](?:|[a-z0-9_.-]*[_a-z0-9])$/i.test(t.name))throw new Error("A type must be given a non-empty name and must match ^[a-z_](?:|[a-z0-9_.-]*[_a-z0-9])$");if("function"!=typeof t.identify&&!1!==t.identify)throw new Error("Type "+t.name+" must specify an identify function or be declared abstract by setting identify to false");if(this.typeByName[t.name])throw new Error("The type with the name "+t.name+" already exists");if(t.base){if(!(n=this.getType(t.base)))throw new Error("Unknown base type: "+t.base)}else n=Lo;var i=Object.create(n);i.inspect=function(t,e,r){if(!r||!r.isMagicPen)throw new Error("You need to pass the output to baseType.inspect() as the third parameter");return n.inspect(t,e,r,function(t,e){return r.clone().appendInspected(t,e)})},i.diff=function(t,e,i){if(!i||!i.isMagicPen)throw new Error("You need to pass the output to baseType.diff() as the third parameter");return Fo(n.diff(t,e,i.clone(),function(t,e){return r.diff(t,e,i.clone())},function(t,e){return i.clone().appendInspected(t,e)},r.equal.bind(r)))},i.equal=function(t,e){return n.equal(t,e,r.equal.bind(r))};var o=Io({},n,t,{baseType:i}),s=o.inspect;if(o.inspect=function(n,r,i,o){if(arguments.length<2||!i||!i.isMagicPen)return"type: "+t.name;if(e){var a=e.createOutput(i.format);return s.call(this,n,r,a,o)||a}return s.call(this,n,r,i,o)||i},e){o.childUnexpected=e;var a=o.diff;o.diff=function(t,n,r,i,o,s){var u=e.createOutput(r.format);return u.output=r.output,a.call(this,t,n,u,i,o,s)||r};}return!1===o.identify?this.types.push(o):this.types.unshift(o),o.level=n.level+1,o.typeEqualityCache={},this.typeByName[o.name]=o,this.expect},Tt.prototype.addStyle=function(){return this.output.addStyle.apply(this.output,arguments),this.expect},Tt.prototype.installTheme=function(){return this.output.installTheme.apply(this.output,arguments),this.expect},Tt.prototype.use=function(t){if("function"!=typeof t&&("object"!==(void 0===t?"undefined":Bo(t))||"function"!=typeof t.installInto)||void 0!==t.name&&"string"!=typeof t.name)throw new Error("Plugins must be functions or adhere to the following interface\n{\n  name: <an optional plugin name>,\n  version: <an optional semver version string>,\n  installInto: <a function that will update the given expect instance>\n}");var e=It(t),n=dn.findFirst(this.installedPlugins,function(n){return n===t||e&&e===It(n)});if(n){if(n===t||void 0!==t.version&&t.version===n.version)return this.expect;throw new Error("Another instance of the plugin '"+e+"' is already installed"+(void 0!==n.version?" (version "+n.version+(void 0!==t.version?", trying to install "+t.version:"")+")":"")+". Please check your node_modules folder for unmet peerDependencies.")}if("unexpected-promise"===e)throw new Error("The unexpected-promise plugin was pulled into Unexpected as of 8.5.0. This means that the plugin is no longer supported.");return this.installedPlugins.push(t),"function"==typeof t?t(this.expect):t.installInto(this.expect),this.expect},Tt.prototype.withError=function(t,e){return go(bo(t).caught(function(t){return vo(t),e(t)}))},Tt.prototype.installPlugin=Tt.prototype.use,Tt.prototype.throwAssertionNotFoundError=function(t,e,n){function r(e,r){var i=o.lookupAssertionRule(t,e,n),s=o.lookupAssertionRule(t,r,n);return i||s?i&&!s?-1:!i&&s?1:Rt(i.specificity,s.specificity):0}var i=this.assertions[e],o=this;i&&this.fail({message:function(r){r.append(un(r.clone(),function(e){e.appendInspected(t);},e,function(t){t.appendItems(n,", ");})).nl().indentLines(),r.i().error("The assertion does not have a matching signature for:").nl().indentLines().i().text("<").text(o.findTypeOf(t).name).text(">").sp().text(e),n.forEach(function(t,e){r.sp().text("<").text(o.findTypeOf(t).name).text(">");}),r.outdentLines().nl().i().text("did you mean:").indentLines().nl(),Object.keys(i.reduce(function(t,e){return t[e.declaration]=!0,t},{})).sort().forEach(function(t,e){r.nl(e>0?1:0).i().text(t);}),r.outdentLines();}});for(var s=[],a=[],u=this;u;)Array.prototype.push.apply(a,Object.keys(u.assertions)),u=u.parent;a.forEach(function(t){var n=Br(e,t);s.push({assertion:t,score:n});},this);var c=s.sort(function(t,e){var n=t.score-e.score;return 0!==n?n:t.assertion<e.assertion?-1:1}).slice(0,10).filter(function(t,e,n){return Math.abs(t.score-n[0].score)<=2}).sort(function(t,e){var n=r(t.assertion,e.assertion);return 0!==n?n:t.score-e.score})[0];this.fail({errorMode:"bubbleThrough",message:function(t){t.error("Unknown assertion '").jsString(e).error("', did you mean: '").jsString(c.assertion).error("'");}});},Tt.prototype.lookupAssertionRule=function(t,e,n,r){function i(t,e){var n=p[e];return n||(n=a.findTypeOf(t),p[e]=n),n}function o(t,e,n,r){return!(!e.is("assertion")||"string"!=typeof t)||(r?!1===e.identify?a.types.some(function(n){return n.identify&&n.is(e)&&n.identify(t)}):e.identify(t):i(t,n).is(e))}function s(e,i){if(!o(t,e.subject.type,"subject",i))return!1;if(r&&!e.args.some(Ct))return!1;var s=Nt(e.args);if(n.length<s.minimum||s.maximum<n.length)return!1;if(0===n.length&&0===s.maximum)return!0;var a=e.args[e.args.length-1];return n.every(function(t,n){return n<e.args.length-1?o(t,e.args[n].type,n,i):o(t,a.type,n,i)})}var a=this;if("string"!=typeof e)throw new Error("The expect function requires the second parameter to be a string or an expect.it.");for(var u,c=this;c;){var f=c.assertions[e];f&&(u=u?u.concat(f):f),c=c.parent;}if(!u)return null;var l,h,p={};for(l=0;l<u.length;l+=1)if(h=u[l],s(h))return h;for(l=0;l<u.length;l+=1)if(h=u[l],s(h,!0))return h;return null},Tt.prototype.setErrorMessage=function(t){t.serializeMessage(this.outputFormat());},Tt.prototype._expect=function(t,e){function n(t,e,i,o){var s=r.lookupAssertionRule(e,i,o);if(!s){var a=i.split(" ");t:for(var u=a.length-1;u>0;u-=1){var c=a.slice(0,u).join(" "),f=a.slice(u),l=[f.join(" ")].concat(o);if(s=r.lookupAssertionRule(e,c,l,!0))for(var h=1;h<f.length;h+=1)if(r.assertions.hasOwnProperty(f.slice(0,h+1).join(" "))){i=c,o=l;break t}}s||r.throwAssertionNotFoundError(e,i,o);}if(s&&s.unexpected&&s.unexpected!==r)return s.unexpected.expect.apply(s.unexpected.expect,[e,i].concat(o));var p=Io({},s.flags),d=function e(r,i){if(0===arguments.length)throw new Error("The expect function requires at least one parameter.");if(1===arguments.length)return _o(bo.resolve(r),e,r);if(i&&i._expectIt)return e.errorMode="nested",e.withError(function(){return i(r)},function(t){e.fail(t);});i=dn.forwardFlags(i,p);for(var o=new Array(arguments.length-2),s=2;s<arguments.length;s+=1)o[s-2]=arguments[s];return e.callInNestedContext(function(){return n(t.child(),r,i,o)})};return dn.setPrototypeOfOrExtend(d,r._wrappedExpectProto),d.context=t,d.execute=d,d.alternations=s.alternations,d.flags=p,d.subject=e,d.testDescription=i,d.args=o,d.assertionRule=s,d.subjectOutput=function(t){t.appendInspected(e);},d.argsOutput=o.map(function(t,e){var n=d.assertionRule.args[e];return"string"==typeof t&&(n&&n.type.is("assertion")||d._getAssertionIndices().indexOf(e)>=0)?new sn(t):function(e){e.appendInspected(t);}}),Object.__defineGetter__||(d.subjectType=d._getSubjectType(),d.argTypes=d._getArgTypes()),go(s.handler.apply(d,[d,e].concat(o)))}var r=this,i=e[0],o=e[1];if(e.length<2)throw new Error("The expect function requires at least two parameters.");if(o&&o._expectIt)return r.expect.withError(function(){return o(i)},function(t){r.fail(t);});try{var s=n(t,i,o,Array.prototype.slice.call(e,2));return wo(s)?(r.expect.notifyPendingPromise(s),s=s.then(void 0,function(e){throw e&&e._isUnexpected&&0===t.level&&r.setErrorMessage(e),e})):s&&"function"==typeof s.then||(s=bo.resolve(s)),_o(s,r.expect,i)}catch(e){if(e&&e._isUnexpected){var a=e;throw"undefined"!=typeof mochaPhantomJS&&(a=e.clone()),0===t.level&&r.setErrorMessage(a),a}throw e}},Tt.prototype.async=function(t){function e(t){n._isAsync=!1,n.expect.fail(function(e){e.error(t).nl().text("Usage: ").nl().text("it('test description', expect.async(function () {").nl().indentLines().i().text("return expect('test.txt', 'to have content', 'Content read asynchroniously');").nl().outdentLines().text("});");});}var n=this;return"function"==typeof t&&0===t.length||e("expect.async requires a callback without arguments."),function(r){n._isAsync&&e("expect.async can't be within a expect.async context."),n._isAsync=!0,"function"!=typeof r&&e("expect.async should be called in the context of an it-block\nand the it-block should supply a done callback.");var i;try{i=t();}finally{n._isAsync=!1;}i&&"function"==typeof i.then||e("expect.async requires the block to return a promise or throw an exception."),i.then(function(){n._isAsync=!1,r();},function(t){n._isAsync=!1,r(t);});}},Tt.prototype.diff=function(t,e,n,r,i){n=n||this.createOutput();var o=this;if((r="number"==typeof r?r:100)<=0){if(-1!==(i=i||[]).indexOf(t))throw new Error("Cannot compare circular structures");i.push(t);}return Fo(this.findCommonType(t,e).diff(t,e,n,function(t,e){return o.diff(t,e,n.clone(),r-1,i)},function(t,e){return n.clone().appendInspected(t,e)},function(t,e){return o.equal(t,e)}))},Tt.prototype.toString=function(){var t=this.assertions,e={},n=[],r=Dr();return Object.keys(t).sort().forEach(function(r){t[r].forEach(function(t){e[t.declaration]||(n.push(t.declaration),e[t.declaration]=!0);});}),n.forEach(function(t){r.text(t).nl();}),r.toString()},Tt.prototype.clone=function(){var t={};Object.keys(this.assertions).forEach(function(e){t[e]=[].concat(this.assertions[e]);},this);var e=new Tt({assertions:t,types:[].concat(this.types),typeByName:Io({},this.typeByName),output:this.output.clone(),format:this.outputFormat(),installedPlugins:[].concat(this.installedPlugins)});return e._expect=this._expect,Ut(e)},Tt.prototype.child=function(){var t=new Tt({assertions:{},types:[],typeByName:{},output:this.output.clone(),format:this.outputFormat(),installedPlugins:[]}),e=t.parent=this,n=Ut(t);return n.exportAssertion=function(n,r){return e.addAssertion(n,r,t),this},n.exportType=function(n){return e.addType(n,t),this},n.exportStyle=function(t,r){return e.addStyle(t,function(){var t=n.createOutput(this.format);this.append(r.apply(t,arguments)||t);}),this},n},Tt.prototype.outputFormat=function(t){return void 0===t?this._outputFormat:(this._outputFormat=t,this.expect)},Tt.prototype.createOutput=function(t){var e=this,n=this.output.clone(t||"text");return n.addStyle("appendInspected",function(t,n){this.append(e.inspect(t,n,this.clone()));}),n},Tt.create=function(){return Ut(new Tt)};var qo=function(){function t(t){return"["===t.slice(0,1)&&"]"===t.slice(-1)}function e(t){return"("===t.slice(0,1)&&")"===t.slice(-1)}function n(t){return t.filter(function(t){return""!==t})}function r(n,i){if(i===n.length)return[{text:"",flags:{},alternations:[]}];var o=n[i],s=r(n,i+1);if(t(o)){var a=o.slice(1,-1);return s.map(function(t){var e={};return e[a]=!0,{text:a+" "+t.text,flags:Io(e,t.flags),alternations:t.alternations}}).concat(s.map(function(t){var e={};return e[a]=!1,{text:t.text,flags:Io(e,t.flags),alternations:t.alternations}}))}return e(o)?o.substr(1,o.length-2).split(/\|/).reduce(function(t,e){return t.concat(s.map(function(t){return{text:e?e+t.text:t.text.replace(/^ /,""),flags:t.flags,alternations:[e].concat(t.alternations)}}))},[]):s.map(function(t){return{text:o+t.text,flags:t.flags,alternations:t.alternations}})}return function(t){t=t.replace(/(\[[^\]]+\]) ?/g,"$1");for(var e,i=/\[[^\]]+\]|\([^\)]+\)/g,o=[],s=0;e=i.exec(t);)o.push(t.slice(s,e.index)),o.push(t.slice(e.index,i.lastIndex)),s=i.lastIndex;o.push(t.slice(s));var a=r(o=n(o),0);return a.forEach(function(t){if(t.text=t.text.trim(),""===t.text)throw new Error("Assertion patterns must not only contain flags")}),a}}(),Ho=Tt,$o=t(function(t){!function(e,n){var r=function(){function t(t,e,n){if(Array.prototype.map)return Array.prototype.map.call(t,e,n);for(var r=new Array(t.length),i=0,o=t.length;i<o;i++)r[i]=e.call(n,t[i],i,t);return r}function e(t){return{newPos:t.newPos,components:t.components.slice(0)}}function n(t){for(var e=[],n=0;n<t.length;n++)t[n]&&e.push(t[n]);return e}function r(t){var e=t;return e=e.replace(/&/g,"&amp;"),e=e.replace(/</g,"&lt;"),e=e.replace(/>/g,"&gt;"),e=e.replace(/"/g,"&quot;")}var i=function(t){this.ignoreWhitespace=t;};i.prototype={diff:function(t,n){if(n===t)return[{value:n}];if(!n)return[{value:t,removed:!0}];if(!t)return[{value:n,added:!0}];n=this.tokenize(n),t=this.tokenize(t);var r=n.length,i=t.length,o=r+i,s=[{newPos:-1,components:[]}],a=this.extractCommon(s[0],n,t,0);if(s[0].newPos+1>=r&&a+1>=i)return s[0].components;for(var u=1;u<=o;u++)for(var c=-1*u;c<=u;c+=2){var f,l=s[c-1],h=s[c+1];a=(h?h.newPos:0)-c,l&&(s[c-1]=void 0);var p=l&&l.newPos+1<r,d=h&&0<=a&&a<i;if(p||d){!p||d&&l.newPos<h.newPos?(f=e(h),this.pushComponent(f.components,t[a],void 0,!0)):((f=e(l)).newPos++,this.pushComponent(f.components,n[f.newPos],!0,void 0));a=this.extractCommon(f,n,t,c);if(f.newPos+1>=r&&a+1>=i)return f.components;s[c]=f;}else s[c]=void 0;}},pushComponent:function(t,e,n,r){var i=t[t.length-1];i&&i.added===n&&i.removed===r?t[t.length-1]={value:this.join(i.value,e),added:n,removed:r}:t.push({value:e,added:n,removed:r});},extractCommon:function(t,e,n,r){for(var i=e.length,o=n.length,s=t.newPos,a=s-r;s+1<i&&a+1<o&&this.equals(e[s+1],n[a+1]);)s++,a++,this.pushComponent(t.components,e[s],void 0,void 0);return t.newPos=s,a},equals:function(t,e){var n=/\S/;return!(!this.ignoreWhitespace||n.test(t)||n.test(e))||t===e},join:function(t,e){return t+e},tokenize:function(t){return t}};var o=new i,s=new i(!0),a=new i;s.tokenize=a.tokenize=function(t){return n(t.split(/(\s+|\b)/))};var u=new i(!0);u.tokenize=function(t){return n(t.split(/([{}:;,]|\s+)/))};var c=new i;return c.tokenize=function(t){for(var e=[],n=t.split(/^/m),r=0;r<n.length;r++){var i=n[r],o=n[r-1];"\n"==i&&o&&"\r"===o[o.length-1]?e[e.length-1]+="\n":i&&e.push(i);}return e},{Diff:i,diffChars:function(t,e){return o.diff(t,e)},diffWords:function(t,e){return s.diff(t,e)},diffWordsWithSpace:function(t,e){return a.diff(t,e)},diffLines:function(t,e){return c.diff(t,e)},diffCss:function(t,e){return u.diff(t,e)},createPatch:function(e,n,r,i,o){function s(e){return t(e,function(t){return" "+t})}function a(t,e,n){var r=f[f.length-2],i=e===f.length-2,o=e===f.length-3&&(n.added!==r.added||n.removed!==r.removed);/\n$/.test(n.value)||!i&&!o||t.push("\\ No newline at end of file");}var u=[];u.push("Index: "+e),u.push("==================================================================="),u.push("--- "+e+(void 0===i?"":"\t"+i)),u.push("+++ "+e+(void 0===o?"":"\t"+o));var f=c.diff(n,r);f[f.length-1].value||f.pop(),f.push({value:"",lines:[]});for(var l=0,h=0,p=[],d=1,y=1,g=0;g<f.length;g++){var v=f[g],m=v.lines||v.value.replace(/\n$/,"").split("\n");if(v.lines=m,v.added||v.removed){if(!l){var b=f[g-1];l=d,h=y,b&&(l-=(p=s(b.lines.slice(-4))).length,h-=p.length);}p.push.apply(p,t(m,function(t){return(v.added?"+":"-")+t})),a(p,g,v),v.added?y+=m.length:d+=m.length;}else{if(l)if(m.length<=8&&g<f.length-2)p.push.apply(p,s(m));else{var _=Math.min(m.length,4);u.push("@@ -"+l+","+(d-l+_)+" +"+h+","+(y-h+_)+" @@"),u.push.apply(u,p),u.push.apply(u,s(m.slice(0,_))),m.length<=4&&a(u,g,v),l=0,h=0,p=[];}d+=m.length,y+=m.length;}}return u.join("\n")+"\n"},applyPatch:function(t,e){for(var n=e.split("\n"),r=[],i=!1,o=!1,s="I"===n[0][0]?4:0;s<n.length;s++)if("@"===n[s][0]){var a=n[s].split(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/);r.unshift({start:a[3],oldlength:a[2],oldlines:[],newlength:a[4],newlines:[]});}else"+"===n[s][0]?r[0].newlines.push(n[s].substr(1)):"-"===n[s][0]?r[0].oldlines.push(n[s].substr(1)):" "===n[s][0]?(r[0].newlines.push(n[s].substr(1)),r[0].oldlines.push(n[s].substr(1))):"\\"===n[s][0]&&("+"===n[s-1][0]?i=!0:"-"===n[s-1][0]&&(o=!0));for(var u=t.split("\n"),s=r.length-1;s>=0;s--){for(var c=r[s],f=0;f<c.oldlength;f++)if(u[c.start-1+f]!==c.oldlines[f])return!1;Array.prototype.splice.apply(u,[c.start-1,+c.oldlength].concat(c.newlines));}if(i)for(;!u[u.length-1];)u.pop();else o&&u.push("");return u.join("\n")},convertChangesToXML:function(t){for(var e=[],n=0;n<t.length;n++){var i=t[n];i.added?e.push("<ins>"):i.removed&&e.push("<del>"),e.push(r(i.value)),i.added?e.push("</ins>"):i.removed&&e.push("</del>");}return e.join("")},convertChangesToDMP:function(t){for(var e,n=[],r=0;r<t.length;r++)e=t[r],n.push([e.added?1:e.removed?-1:0,e.value]);return n}}}();t.exports=r;}();}),Yo=/([\x00-\x09\x0B-\x1F\x7F-\x9F\xAD\u0378\u0379\u037F-\u0383\u038B\u038D\u03A2\u0528-\u0530\u0557\u0558\u0560\u0588\u058B-\u058E\u0590\u05C8-\u05CF\u05EB-\u05EF\u05F5-\u0605\u061C\u061D\u06DD\u070E\u070F\u074B\u074C\u07B2-\u07BF\u07FB-\u07FF\u082E\u082F\u083F\u085C\u085D\u085F-\u089F\u08A1\u08AD-\u08E3\u08FF\u0978\u0980\u0984\u098D\u098E\u0991\u0992\u09A9\u09B1\u09B3-\u09B5\u09BA\u09BB\u09C5\u09C6\u09C9\u09CA\u09CF-\u09D6\u09D8-\u09DB\u09DE\u09E4\u09E5\u09FC-\u0A00\u0A04\u0A0B-\u0A0E\u0A11\u0A12\u0A29\u0A31\u0A34\u0A37\u0A3A\u0A3B\u0A3D\u0A43-\u0A46\u0A49\u0A4A\u0A4E-\u0A50\u0A52-\u0A58\u0A5D\u0A5F-\u0A65\u0A76-\u0A80\u0A84\u0A8E\u0A92\u0AA9\u0AB1\u0AB4\u0ABA\u0ABB\u0AC6\u0ACA\u0ACE\u0ACF\u0AD1-\u0ADF\u0AE4\u0AE5\u0AF2-\u0B00\u0B04\u0B0D\u0B0E\u0B11\u0B12\u0B29\u0B31\u0B34\u0B3A\u0B3B\u0B45\u0B46\u0B49\u0B4A\u0B4E-\u0B55\u0B58-\u0B5B\u0B5E\u0B64\u0B65\u0B78-\u0B81\u0B84\u0B8B-\u0B8D\u0B91\u0B96-\u0B98\u0B9B\u0B9D\u0BA0-\u0BA2\u0BA5-\u0BA7\u0BAB-\u0BAD\u0BBA-\u0BBD\u0BC3-\u0BC5\u0BC9\u0BCE\u0BCF\u0BD1-\u0BD6\u0BD8-\u0BE5\u0BFB-\u0C00\u0C04\u0C0D\u0C11\u0C29\u0C34\u0C3A-\u0C3C\u0C45\u0C49\u0C4E-\u0C54\u0C57\u0C5A-\u0C5F\u0C64\u0C65\u0C70-\u0C77\u0C80\u0C81\u0C84\u0C8D\u0C91\u0CA9\u0CB4\u0CBA\u0CBB\u0CC5\u0CC9\u0CCE-\u0CD4\u0CD7-\u0CDD\u0CDF\u0CE4\u0CE5\u0CF0\u0CF3-\u0D01\u0D04\u0D0D\u0D11\u0D3B\u0D3C\u0D45\u0D49\u0D4F-\u0D56\u0D58-\u0D5F\u0D64\u0D65\u0D76-\u0D78\u0D80\u0D81\u0D84\u0D97-\u0D99\u0DB2\u0DBC\u0DBE\u0DBF\u0DC7-\u0DC9\u0DCB-\u0DCE\u0DD5\u0DD7\u0DE0-\u0DF1\u0DF5-\u0E00\u0E3B-\u0E3E\u0E5C-\u0E80\u0E83\u0E85\u0E86\u0E89\u0E8B\u0E8C\u0E8E-\u0E93\u0E98\u0EA0\u0EA4\u0EA6\u0EA8\u0EA9\u0EAC\u0EBA\u0EBE\u0EBF\u0EC5\u0EC7\u0ECE\u0ECF\u0EDA\u0EDB\u0EE0-\u0EFF\u0F48\u0F6D-\u0F70\u0F98\u0FBD\u0FCD\u0FDB-\u0FFF\u10C6\u10C8-\u10CC\u10CE\u10CF\u1249\u124E\u124F\u1257\u1259\u125E\u125F\u1289\u128E\u128F\u12B1\u12B6\u12B7\u12BF\u12C1\u12C6\u12C7\u12D7\u1311\u1316\u1317\u135B\u135C\u137D-\u137F\u139A-\u139F\u13F5-\u13FF\u169D-\u169F\u16F1-\u16FF\u170D\u1715-\u171F\u1737-\u173F\u1754-\u175F\u176D\u1771\u1774-\u177F\u17DE\u17DF\u17EA-\u17EF\u17FA-\u17FF\u180F\u181A-\u181F\u1878-\u187F\u18AB-\u18AF\u18F6-\u18FF\u191D-\u191F\u192C-\u192F\u193C-\u193F\u1941-\u1943\u196E\u196F\u1975-\u197F\u19AC-\u19AF\u19CA-\u19CF\u19DB-\u19DD\u1A1C\u1A1D\u1A5F\u1A7D\u1A7E\u1A8A-\u1A8F\u1A9A-\u1A9F\u1AAE-\u1AFF\u1B4C-\u1B4F\u1B7D-\u1B7F\u1BF4-\u1BFB\u1C38-\u1C3A\u1C4A-\u1C4C\u1C80-\u1CBF\u1CC8-\u1CCF\u1CF7-\u1CFF\u1DE7-\u1DFB\u1F16\u1F17\u1F1E\u1F1F\u1F46\u1F47\u1F4E\u1F4F\u1F58\u1F5A\u1F5C\u1F5E\u1F7E\u1F7F\u1FB5\u1FC5\u1FD4\u1FD5\u1FDC\u1FF0\u1FF1\u1FF5\u1FFF\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2072\u2073\u208F\u209D-\u209F\u20BA-\u20CF\u20F1-\u20FF\u218A-\u218F\u23F4-\u23FF\u2427-\u243F\u244B-\u245F\u2700\u2B4D-\u2B4F\u2B5A-\u2BFF\u2C2F\u2C5F\u2CF4-\u2CF8\u2D26\u2D28-\u2D2C\u2D2E\u2D2F\u2D68-\u2D6E\u2D71-\u2D7E\u2D97-\u2D9F\u2DA7\u2DAF\u2DB7\u2DBF\u2DC7\u2DCF\u2DD7\u2DDF\u2E3C-\u2E7F\u2E9A\u2EF4-\u2EFF\u2FD6-\u2FEF\u2FFC-\u2FFF\u3040\u3097\u3098\u3100-\u3104\u312E-\u3130\u318F\u31BB-\u31BF\u31E4-\u31EF\u321F\u32FF\u4DB6-\u4DBF\u9FCD-\u9FFF\uA48D-\uA48F\uA4C7-\uA4CF\uA62C-\uA63F\uA698-\uA69E\uA6F8-\uA6FF\uA78F\uA794-\uA79F\uA7AB-\uA7F7\uA82C-\uA82F\uA83A-\uA83F\uA878-\uA87F\uA8C5-\uA8CD\uA8DA-\uA8DF\uA8FC-\uA8FF\uA954-\uA95E\uA97D-\uA97F\uA9CE\uA9DA-\uA9DD\uA9E0-\uA9FF\uAA37-\uAA3F\uAA4E\uAA4F\uAA5A\uAA5B\uAA7C-\uAA7F\uAAC3-\uAADA\uAAF7-\uAB00\uAB07\uAB08\uAB0F\uAB10\uAB17-\uAB1F\uAB27\uAB2F-\uABBF\uABEE\uABEF\uABFA-\uABFF\uD7A4-\uD7AF\uD7C7-\uD7CA\uD7FC-\uF8FF\uFA6E\uFA6F\uFADA-\uFAFF\uFB07-\uFB12\uFB18-\uFB1C\uFB37\uFB3D\uFB3F\uFB42\uFB45\uFBC2-\uFBD2\uFD40-\uFD4F\uFD90\uFD91\uFDC8-\uFDEF\uFDFE\uFDFF\uFE1A-\uFE1F\uFE27-\uFE2F\uFE53\uFE67\uFE6C-\uFE6F\uFE75\uFEFD-\uFF00\uFFBF-\uFFC1\uFFC8\uFFC9\uFFD0\uFFD1\uFFD8\uFFD9\uFFDD-\uFFDF\uFFE7\uFFEF-\uFFFB\uFFFE\uFFFF])/g,Wo="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},Vo=function(t){t.installTheme({styles:{jsBoolean:"jsPrimitive",jsNumber:"jsPrimitive",error:["red","bold"],success:["green","bold"],diffAddedLine:"green",diffAddedHighlight:["bgGreen","white"],diffAddedSpecialChar:["bgGreen","cyan","bold"],diffRemovedLine:"red",diffRemovedHighlight:["bgRed","white"],diffRemovedSpecialChar:["bgRed","cyan","bold"],partialMatchHighlight:["bgYellow"]}}),t.installTheme("html",{palette:["#993333","#669933","#314575","#337777","#710071","#319916","#BB1A53","#999933","#4311C2","#996633","#993399","#333399","#228842","#C24747","#336699","#663399"],styles:{jsComment:"#969896",jsFunctionName:"#795da3",jsKeyword:"#a71d5d",jsPrimitive:"#0086b3",jsRegexp:"#183691",jsString:"#df5000",jsKey:"#555"}}),t.installTheme("ansi",{palette:["#FF1A53","#E494FF","#1A53FF","#FF1AC6","#1AFF53","#D557FF","#81FF57","#C6FF1A","#531AFF","#AFFF94","#C61AFF","#53FF1A","#FF531A","#1AFFC6","#FFC61A","#1AC6FF"],styles:{jsComment:"gray",jsFunctionName:"jsKeyword",jsKeyword:"magenta",jsNumber:[],jsPrimitive:"cyan",jsRegexp:"green",jsString:"cyan",jsKey:"#666",diffAddedHighlight:["bgGreen","black"],diffRemovedHighlight:["bgRed","black"],partialMatchHighlight:["bgYellow","black"]}}),t.addStyle("colorByIndex",function(t,e){var n=this.theme().palette;if(n){var r=n[e%n.length];this.text(t,r);}else this.text(t);}),t.addStyle("singleQuotedString",function(t){t=String(t),this.jsString("'").jsString(t.replace(/[\\\x00-\x1f']/g,function(t){if("\n"===t)return"\\n";if("\r"===t)return"\\r";if("'"===t)return"\\'";if("\\"===t)return"\\\\";if("\t"===t)return"\\t";if("\b"===t)return"\\b";if("\f"===t)return"\\f";var e=t.charCodeAt(0);return"\\x"+(e<16?"0":"")+e.toString(16)})).jsString("'");}),t.addStyle("property",function(t,e,n){var r=!1;"symbol"===(void 0===t?"undefined":Wo(t))?this.text("[").sp().appendInspected(t).sp().text("]").text(":"):(t=String(t),/^[a-z\$\_][a-z0-9\$\_]*$/i.test(t)?this.text(t,"jsKey").text(":"):/^(?:0|[1-9][0-9]*)$/.test(t)?n?r=!0:this.jsNumber(t).text(":"):this.singleQuotedString(t).text(":")),e.isEmpty()||(r||(t.length>5&&e.isBlock()&&e.isMultiline()?(this.indentLines(),this.nl().i()):this.sp()),this.append(e));}),t.addStyle("code",function(t,e){this.text(t);}),t.addStyle("annotationBlock",function(){var t=this.getContentFromArguments(arguments),e=t.size().height;this.block(function(){for(var t=0;t<e;t+=1)0<t&&this.nl(),this.error("//");}),this.sp().block(t);}),t.addStyle("commentBlock",function(){var t=this.getContentFromArguments(arguments),e=t.size().height;this.block(function(){for(var t=0;t<e;t+=1)0<t&&this.nl(),this.jsComment("//");}),this.sp().block(t);}),t.addStyle("removedHighlight",function(t){this.alt({text:function(){t.split(/(\n)/).forEach(function(t){"\n"===t?this.nl():this.block(function(){this.text(t).nl().text(t.replace(/[\s\S]/g,"^"));});},this);},fallback:function(){this.diffRemovedHighlight(t);}});}),t.addStyle("match",function(t){this.alt({text:function(){t.split(/(\n)/).forEach(function(t){"\n"===t?this.nl():this.block(function(){this.text(t).nl().text(t.replace(/[\s\S]/g,"^"));});},this);},fallback:function(){this.diffAddedHighlight(t);}});}),t.addStyle("partialMatch",function(t){this.alt({text:function(){this.match(t);},fallback:function(){this.partialMatchHighlight(t);}});}),t.addStyle("shouldEqualError",function(t){this.error(void 0===t?"should be":"should equal").sp().block(function(){this.appendInspected(t);});}),t.addStyle("errorName",function(t){"string"==typeof t.name&&"Error"!==t.name?this.text(t.name):t.constructor&&"string"==typeof t.constructor.name?this.text(t.constructor.name):this.text("Error");}),t.addStyle("appendErrorMessage",function(t,e){t&&t.isUnexpected?this.append(t.getErrorMessage(dn.extend({output:this},e))):this.appendInspected(t);}),t.addStyle("appendItems",function(t,e){var n=this;e=e||"",t.forEach(function(t,r){0<r&&n.append(e),n.appendInspected(t);});}),t.addStyle("stringDiffFragment",function(t,e,n,r){e.split(/\n/).forEach(function(e,i,o){this.isAtStartOfLine()&&this.alt({text:t,fallback:function(){""!==e||" "===t||0!==i&&i===o.length-1||this["+"===t?"diffAddedSpecialChar":"diffRemovedSpecialChar"]("\\n");}});var s=e.match(/^(.*[^ ])?( +)$/);s&&(e=s[1]||""),r?e.split(Yo).forEach(function(e){Yo.test(e)?this[{"+":"diffAddedSpecialChar","-":"diffRemovedSpecialChar"}[t]||n](dn.escapeChar(e)):this[n](e);},this):this[n](e),s&&this[{"+":"diffAddedHighlight","-":"diffRemovedHighlight"}[t]||n](s[2]),i!==o.length-1&&this.nl();},this);}),t.addStyle("stringDiff",function(t,e,n){var r,i=(n=n||{}).type||"WordsWithSpace",o=[];$o.diffLines(t,e).forEach(function(t){r&&r.added&&t.removed?(o.push({oldValue:t.value,newValue:r.value,replaced:!0}),r=null):(r&&o.push(r),r=t);}),r&&o.push(r),o.forEach(function(t,e){if(t.replaced){var r=t.oldValue,s=t.newValue,a=this.clone(),u="\n"===r.slice(-1),c="\n"===s.slice(-1);u&&(r=r.slice(0,-1)),c&&(s=s.slice(0,-1)),$o["diff"+i](r,s).forEach(function(t){t.added?a.stringDiffFragment("+",t.value,"diffAddedHighlight",n.markUpSpecialCharacters):t.removed?this.stringDiffFragment("-",t.value,"diffRemovedHighlight",n.markUpSpecialCharacters):(a.stringDiffFragment("+",t.value,"diffAddedLine"),this.stringDiffFragment("-",t.value,"diffRemovedLine"));},this),c&&!u&&a.diffAddedSpecialChar("\\n"),u&&!c&&this.diffRemovedSpecialChar("\\n"),this.nl().append(a).nl(u&&e<o.length-1?1:0);}else{var f=/\n$/.test(t.value),l=f?t.value.slice(0,-1):t.value;t.added?this.stringDiffFragment("+",l,"diffAddedLine",n.markUpSpecialCharacters):t.removed?this.stringDiffFragment("-",l,"diffRemovedLine",n.markUpSpecialCharacters):this.stringDiffFragment(" ",l,"text"),f&&this.nl();}},this);}),t.addStyle("arrow",function(t){var e,n=(t=t||{}).styles||[];for(this.nl(t.top||0).sp(t.left||0).text("┌",n),e=1;e<t.width;e+=1)this.text(e===t.width-1&&"up"===t.direction?"▷":"─",n);for(this.nl(),e=1;e<t.height-1;e+=1)this.sp(t.left||0).text("│",n).nl();for(this.sp(t.left||0).text("└",n),e=1;e<t.width;e+=1)this.text(e===t.width-1&&"down"===t.direction?"▷":"─",n);});var e=tr;t.addStyle("merge",function(t){for(var n=t.map(function(t){return e(t.output)}).reverse(),r=n.reduce(function(t,e){return Math.max(t,e.length)},0),i=new Array(n.length),o=new Array(n.length),s=0;s<r;s+=1){s>0&&this.nl();var a;for(a=0;a<i.length;a+=1)i[a]=0,o[a]=0;var u;do{u=!1;var c=!1;for(a=0;a<n.length;a+=1){var f=n[a][s];if(f){for(;f[i[a]]&&o[a]>=f[i[a]].args.content.length;)i[a]+=1,o[a]=0;var l=f[i[a]];if(l){if(u=!0,!c){var h=l.args.content.charAt(o[a]);" "!==h&&(this.text(h,l.args.styles),c=!0);}o[a]+=1;}}}!c&&u&&this.sp();}while(u)}}),t.addStyle("arrowsAlongsideChangeOutputs",function(t,e){if(t){var n={},r=0;e.forEach(function(t,e){n[e]=r,r+=t.size().height;});var i=this,o=[];t.forEach(function(t,e,r){t.forEach(function(t){o.push(i.clone().arrow({left:2*e,top:n[t.start],width:1+2*(r.length-e),height:n[t.end]-n[t.start]+1,direction:t.direction}));});}),1===o.length?this.block(o[0]):o.length>1&&this.block(function(){this.merge(o);});}else this.i();this.block(function(){e.forEach(function(e,n){this.nl(n>0?1:0),e.isEmpty()||this.sp(t?1:0).append(e);},this);});});},Ko=[],Qo=[],Jo="undefined"!=typeof Uint8Array?Uint8Array:Array,Go=!1,Xo={}.toString,Zo=Array.isArray||function(t){return"[object Array]"==Xo.call(t)},ts=50;Gt.TYPED_ARRAY_SUPPORT=void 0===yn.TYPED_ARRAY_SUPPORT||yn.TYPED_ARRAY_SUPPORT,Gt.poolSize=8192,Gt._augment=function(t){return t.__proto__=Gt.prototype,t},Gt.from=function(t,e,n){return Xt(null,t,e,n)},Gt.TYPED_ARRAY_SUPPORT&&(Gt.prototype.__proto__=Uint8Array.prototype,Gt.__proto__=Uint8Array,"undefined"!=typeof Symbol&&Symbol.species&&Gt[Symbol.species]),Gt.alloc=function(t,e,n){return te(null,t,e,n)},Gt.allocUnsafe=function(t){return ee(null,t)},Gt.allocUnsafeSlow=function(t){return ee(null,t)},Gt.isBuffer=qe,Gt.compare=function(t,e){if(!ae(t)||!ae(e))throw new TypeError("Arguments must be Buffers");if(t===e)return 0;for(var n=t.length,r=e.length,i=0,o=Math.min(n,r);i<o;++i)if(t[i]!==e[i]){n=t[i],r=e[i];break}return n<r?-1:r<n?1:0},Gt.isEncoding=function(t){switch(String(t).toLowerCase()){case"hex":case"utf8":case"utf-8":case"ascii":case"latin1":case"binary":case"base64":case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return!0;default:return!1}},Gt.concat=function(t,e){if(!Zo(t))throw new TypeError('"list" argument must be an Array of Buffers');if(0===t.length)return Gt.alloc(0);var n;if(void 0===e)for(e=0,n=0;n<t.length;++n)e+=t[n].length;var r=Gt.allocUnsafe(e),i=0;for(n=0;n<t.length;++n){var o=t[n];if(!ae(o))throw new TypeError('"list" argument must be an Array of Buffers');o.copy(r,i),i+=o.length;}return r},Gt.byteLength=ue,Gt.prototype._isBuffer=!0,Gt.prototype.swap16=function(){var t=this.length;if(t%2!=0)throw new RangeError("Buffer size must be a multiple of 16-bits");for(var e=0;e<t;e+=2)fe(this,e,e+1);return this},Gt.prototype.swap32=function(){var t=this.length;if(t%4!=0)throw new RangeError("Buffer size must be a multiple of 32-bits");for(var e=0;e<t;e+=4)fe(this,e,e+3),fe(this,e+1,e+2);return this},Gt.prototype.swap64=function(){var t=this.length;if(t%8!=0)throw new RangeError("Buffer size must be a multiple of 64-bits");for(var e=0;e<t;e+=8)fe(this,e,e+7),fe(this,e+1,e+6),fe(this,e+2,e+5),fe(this,e+3,e+4);return this},Gt.prototype.toString=function(){var t=0|this.length;return 0===t?"":0===arguments.length?_e(this,0,t):ce.apply(this,arguments)},Gt.prototype.equals=function(t){if(!ae(t))throw new TypeError("Argument must be a Buffer");return this===t||0===Gt.compare(this,t)},Gt.prototype.inspect=function(){var t="",e=ts;return this.length>0&&(t=this.toString("hex",0,e).match(/.{2}/g).join(" "),this.length>e&&(t+=" ... ")),"<Buffer "+t+">"},Gt.prototype.compare=function(t,e,n,r,i){if(!ae(t))throw new TypeError("Argument must be a Buffer");if(void 0===e&&(e=0),void 0===n&&(n=t?t.length:0),void 0===r&&(r=0),void 0===i&&(i=this.length),e<0||n>t.length||r<0||i>this.length)throw new RangeError("out of range index");if(r>=i&&e>=n)return 0;if(r>=i)return-1;if(e>=n)return 1;if(e>>>=0,n>>>=0,r>>>=0,i>>>=0,this===t)return 0;for(var o=i-r,s=n-e,a=Math.min(o,s),u=this.slice(r,i),c=t.slice(e,n),f=0;f<a;++f)if(u[f]!==c[f]){o=u[f],s=c[f];break}return o<s?-1:s<o?1:0},Gt.prototype.includes=function(t,e,n){return-1!==this.indexOf(t,e,n)},Gt.prototype.indexOf=function(t,e,n){return le(this,t,e,n,!0)},Gt.prototype.lastIndexOf=function(t,e,n){return le(this,t,e,n,!1)},Gt.prototype.write=function(t,e,n,r){if(void 0===e)r="utf8",n=this.length,e=0;else if(void 0===n&&"string"==typeof e)r=e,n=this.length,e=0;else{if(!isFinite(e))throw new Error("Buffer.write(string, encoding, offset[, length]) is no longer supported");e|=0,isFinite(n)?(n|=0,void 0===r&&(r="utf8")):(r=n,n=void 0);}var i=this.length-e;if((void 0===n||n>i)&&(n=i),t.length>0&&(n<0||e<0)||e>this.length)throw new RangeError("Attempt to write outside buffer bounds");r||(r="utf8");for(var o=!1;;)switch(r){case"hex":return pe(this,t,e,n);case"utf8":case"utf-8":return de(this,t,e,n);case"ascii":return ye(this,t,e,n);case"latin1":case"binary":return ge(this,t,e,n);case"base64":return ve(this,t,e,n);case"ucs2":case"ucs-2":case"utf16le":case"utf-16le":return me(this,t,e,n);default:if(o)throw new TypeError("Unknown encoding: "+r);r=(""+r).toLowerCase(),o=!0;}},Gt.prototype.toJSON=function(){return{type:"Buffer",data:Array.prototype.slice.call(this._arr||this,0)}};var es=4096;Gt.prototype.slice=function(t,e){var n=this.length;t=~~t,e=void 0===e?n:~~e,t<0?(t+=n)<0&&(t=0):t>n&&(t=n),e<0?(e+=n)<0&&(e=0):e>n&&(e=n),e<t&&(e=t);var r;if(Gt.TYPED_ARRAY_SUPPORT)(r=this.subarray(t,e)).__proto__=Gt.prototype;else{var i=e-t;r=new Gt(i,void 0);for(var o=0;o<i;++o)r[o]=this[o+t];}return r},Gt.prototype.readUIntLE=function(t,e,n){t|=0,e|=0,n||je(t,e,this.length);for(var r=this[t],i=1,o=0;++o<e&&(i*=256);)r+=this[t+o]*i;return r},Gt.prototype.readUIntBE=function(t,e,n){t|=0,e|=0,n||je(t,e,this.length);for(var r=this[t+--e],i=1;e>0&&(i*=256);)r+=this[t+--e]*i;return r},Gt.prototype.readUInt8=function(t,e){return e||je(t,1,this.length),this[t]},Gt.prototype.readUInt16LE=function(t,e){return e||je(t,2,this.length),this[t]|this[t+1]<<8},Gt.prototype.readUInt16BE=function(t,e){return e||je(t,2,this.length),this[t]<<8|this[t+1]},Gt.prototype.readUInt32LE=function(t,e){return e||je(t,4,this.length),(this[t]|this[t+1]<<8|this[t+2]<<16)+16777216*this[t+3]},Gt.prototype.readUInt32BE=function(t,e){return e||je(t,4,this.length),16777216*this[t]+(this[t+1]<<16|this[t+2]<<8|this[t+3])},Gt.prototype.readIntLE=function(t,e,n){t|=0,e|=0,n||je(t,e,this.length);for(var r=this[t],i=1,o=0;++o<e&&(i*=256);)r+=this[t+o]*i;return i*=128,r>=i&&(r-=Math.pow(2,8*e)),r},Gt.prototype.readIntBE=function(t,e,n){t|=0,e|=0,n||je(t,e,this.length);for(var r=e,i=1,o=this[t+--r];r>0&&(i*=256);)o+=this[t+--r]*i;return i*=128,o>=i&&(o-=Math.pow(2,8*e)),o},Gt.prototype.readInt8=function(t,e){return e||je(t,1,this.length),128&this[t]?-1*(255-this[t]+1):this[t]},Gt.prototype.readInt16LE=function(t,e){e||je(t,2,this.length);var n=this[t]|this[t+1]<<8;return 32768&n?4294901760|n:n},Gt.prototype.readInt16BE=function(t,e){e||je(t,2,this.length);var n=this[t+1]|this[t]<<8;return 32768&n?4294901760|n:n},Gt.prototype.readInt32LE=function(t,e){return e||je(t,4,this.length),this[t]|this[t+1]<<8|this[t+2]<<16|this[t+3]<<24},Gt.prototype.readInt32BE=function(t,e){return e||je(t,4,this.length),this[t]<<24|this[t+1]<<16|this[t+2]<<8|this[t+3]},Gt.prototype.readFloatLE=function(t,e){return e||je(t,4,this.length),Vt(this,t,!0,23,4)},Gt.prototype.readFloatBE=function(t,e){return e||je(t,4,this.length),Vt(this,t,!1,23,4)},Gt.prototype.readDoubleLE=function(t,e){return e||je(t,8,this.length),Vt(this,t,!0,52,8)},Gt.prototype.readDoubleBE=function(t,e){return e||je(t,8,this.length),Vt(this,t,!1,52,8)},Gt.prototype.writeUIntLE=function(t,e,n,r){t=+t,e|=0,n|=0,r||ke(this,t,e,n,Math.pow(2,8*n)-1,0);var i=1,o=0;for(this[e]=255&t;++o<n&&(i*=256);)this[e+o]=t/i&255;return e+n},Gt.prototype.writeUIntBE=function(t,e,n,r){t=+t,e|=0,n|=0,r||ke(this,t,e,n,Math.pow(2,8*n)-1,0);var i=n-1,o=1;for(this[e+i]=255&t;--i>=0&&(o*=256);)this[e+i]=t/o&255;return e+n},Gt.prototype.writeUInt8=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,1,255,0),Gt.TYPED_ARRAY_SUPPORT||(t=Math.floor(t)),this[e]=255&t,e+1},Gt.prototype.writeUInt16LE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,2,65535,0),Gt.TYPED_ARRAY_SUPPORT?(this[e]=255&t,this[e+1]=t>>>8):Ce(this,t,e,!0),e+2},Gt.prototype.writeUInt16BE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,2,65535,0),Gt.TYPED_ARRAY_SUPPORT?(this[e]=t>>>8,this[e+1]=255&t):Ce(this,t,e,!1),e+2},Gt.prototype.writeUInt32LE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,4,4294967295,0),Gt.TYPED_ARRAY_SUPPORT?(this[e+3]=t>>>24,this[e+2]=t>>>16,this[e+1]=t>>>8,this[e]=255&t):Se(this,t,e,!0),e+4},Gt.prototype.writeUInt32BE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,4,4294967295,0),Gt.TYPED_ARRAY_SUPPORT?(this[e]=t>>>24,this[e+1]=t>>>16,this[e+2]=t>>>8,this[e+3]=255&t):Se(this,t,e,!1),e+4},Gt.prototype.writeIntLE=function(t,e,n,r){if(t=+t,e|=0,!r){var i=Math.pow(2,8*n-1);ke(this,t,e,n,i-1,-i);}var o=0,s=1,a=0;for(this[e]=255&t;++o<n&&(s*=256);)t<0&&0===a&&0!==this[e+o-1]&&(a=1),this[e+o]=(t/s>>0)-a&255;return e+n},Gt.prototype.writeIntBE=function(t,e,n,r){if(t=+t,e|=0,!r){var i=Math.pow(2,8*n-1);ke(this,t,e,n,i-1,-i);}var o=n-1,s=1,a=0;for(this[e+o]=255&t;--o>=0&&(s*=256);)t<0&&0===a&&0!==this[e+o+1]&&(a=1),this[e+o]=(t/s>>0)-a&255;return e+n},Gt.prototype.writeInt8=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,1,127,-128),Gt.TYPED_ARRAY_SUPPORT||(t=Math.floor(t)),t<0&&(t=255+t+1),this[e]=255&t,e+1},Gt.prototype.writeInt16LE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,2,32767,-32768),Gt.TYPED_ARRAY_SUPPORT?(this[e]=255&t,this[e+1]=t>>>8):Ce(this,t,e,!0),e+2},Gt.prototype.writeInt16BE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,2,32767,-32768),Gt.TYPED_ARRAY_SUPPORT?(this[e]=t>>>8,this[e+1]=255&t):Ce(this,t,e,!1),e+2},Gt.prototype.writeInt32LE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,4,2147483647,-2147483648),Gt.TYPED_ARRAY_SUPPORT?(this[e]=255&t,this[e+1]=t>>>8,this[e+2]=t>>>16,this[e+3]=t>>>24):Se(this,t,e,!0),e+4},Gt.prototype.writeInt32BE=function(t,e,n){return t=+t,e|=0,n||ke(this,t,e,4,2147483647,-2147483648),t<0&&(t=4294967295+t+1),Gt.TYPED_ARRAY_SUPPORT?(this[e]=t>>>24,this[e+1]=t>>>16,this[e+2]=t>>>8,this[e+3]=255&t):Se(this,t,e,!1),e+4},Gt.prototype.writeFloatLE=function(t,e,n){return Oe(this,t,e,!0,n)},Gt.prototype.writeFloatBE=function(t,e,n){return Oe(this,t,e,!1,n)},Gt.prototype.writeDoubleLE=function(t,e,n){return Pe(this,t,e,!0,n)},Gt.prototype.writeDoubleBE=function(t,e,n){return Pe(this,t,e,!1,n)},Gt.prototype.copy=function(t,e,n,r){if(n||(n=0),r||0===r||(r=this.length),e>=t.length&&(e=t.length),e||(e=0),r>0&&r<n&&(r=n),r===n)return 0;if(0===t.length||0===this.length)return 0;if(e<0)throw new RangeError("targetStart out of bounds");if(n<0||n>=this.length)throw new RangeError("sourceStart out of bounds");if(r<0)throw new RangeError("sourceEnd out of bounds");r>this.length&&(r=this.length),t.length-e<r-n&&(r=t.length-e+n);var i,o=r-n;if(this===t&&n<e&&e<r)for(i=o-1;i>=0;--i)t[i+e]=this[i+n];else if(o<1e3||!Gt.TYPED_ARRAY_SUPPORT)for(i=0;i<o;++i)t[i+e]=this[i+n];else Uint8Array.prototype.set.call(t,this.subarray(n,n+o),e);return o},Gt.prototype.fill=function(t,e,n,r){if("string"==typeof t){if("string"==typeof e?(r=e,e=0,n=this.length):"string"==typeof n&&(r=n,n=this.length),1===t.length){var i=t.charCodeAt(0);i<256&&(t=i);}if(void 0!==r&&"string"!=typeof r)throw new TypeError("encoding must be a string");if("string"==typeof r&&!Gt.isEncoding(r))throw new TypeError("Unknown encoding: "+r)}else"number"==typeof t&&(t&=255);if(e<0||this.length<e||this.length<n)throw new RangeError("Out of range index");if(n<=e)return this;e>>>=0,n=void 0===n?this.length:n>>>0,t||(t=0);var o;if("number"==typeof t)for(o=e;o<n;++o)this[o]=t;else{var s=ae(t)?t:Be(new Gt(t,r).toString()),a=s.length;for(o=0;o<n-e;++o)this[o+e]=s[o%a];}return this};var ns=/[^+\/0-9A-Za-z-_]/g,rs=Qe;Qe.InsertDiff=Ye,Qe.RemoveDiff=We,Qe.MoveDiff=Ve,Ye.prototype.type="insert",Ye.prototype.toJSON=function(){return{type:this.type,index:this.index,values:this.values}},We.prototype.type="remove",We.prototype.toJSON=function(){return{type:this.type,index:this.index,howMany:this.howMany}},Ve.prototype.type="move",Ve.prototype.toJSON=function(){return{type:this.type,from:this.from,to:this.to,howMany:this.howMany}};var is=function(t,e,n,r,i){function o(t){var e,n=0;for(e=0;e<s.length&&n<t;e+=1)"remove"!==s[e].type&&"moveSource"!==s[e].type&&n++;return e}for(var s=new Array(t.length),a=0;a<t.length;a+=1)s[a]={type:"similar",value:t[a],actualIndex:a};n=n||function(t,e){return t===e},r=r||function(t,e){return!1};var u=rs(Array.prototype.slice.call(t),Array.prototype.slice.call(e),function(t,e,i,o){return n(t,e,i,o)||r(t,e,i,o)}),c=0;u.filter(function(t){return"remove"===t.type}).forEach(function(t){var e=c+t.index;s.slice(e,t.howMany+e).forEach(function(t){t.type="remove";}),c+=t.howMany;}),u.filter(function(t){return"move"===t.type}).forEach(function(t){var e=o(t.from+1)-1,n=s.slice(e,t.howMany+e),r=n.map(function(t){return Je({},t,{last:!1,type:"moveTarget"})});n.forEach(function(t){t.type="moveSource";});var i=o(t.to);Array.prototype.splice.apply(s,[i,0].concat(r));}),u.filter(function(t){return"insert"===t.type}).forEach(function(t){for(var e=new Array(t.values.length),n=0;n<t.values.length;n+=1)e[n]={type:"insert",value:t.values[n],expectedIndex:t.index};var r=o(t.index);Array.prototype.splice.apply(s,[r,0].concat(e));});var f=0;s.forEach(function(t,n){var r=t.type;"remove"===r||"moveSource"===r?f-=1:"similar"===r&&(t.expected=e[f+n],t.expectedIndex=f+n);});var l,h,p=s.reduce(function(t,e){return"similar"===e.type||"moveSource"===e.type||"moveTarget"===e.type?t:t+1},0);for(h=0,l=0;h<Math.max(t.length,e.length)&&l<=p;h+=1)(h>=t.length||h>=e.length||!n(t[h],e[h],h,h)&&!r(t[h],e[h],h,h))&&(l+=1);if(l<=p){s=[];var d;for(d=0;d<Math.min(t.length,e.length);d+=1)s.push({type:"similar",value:t[d],expected:e[d],actualIndex:d,expectedIndex:d});if(t.length<e.length)for(;d<Math.max(t.length,e.length);d+=1)s.push({type:"insert",value:e[d],expectedIndex:d});else for(;d<Math.max(t.length,e.length);d+=1)s.push({type:"remove",value:t[d],actualIndex:d});}if(s.forEach(function(t){"similar"===t.type&&n(t.value,t.expected,t.actualIndex,t.expectedIndex)&&(t.type="equal");}),i){var y;if(Array.isArray(i))y=i;else{var g={};y=[],[t,e].forEach(function(t){Object.keys(t).forEach(function(t){/^(?:0|[1-9][0-9]*)$/.test(t)||g[t]||(g[t]=!0,y.push(t));}),Object.getOwnPropertySymbols&&Object.getOwnPropertySymbols(t).forEach(function(t){g[t]||(g[t]=!0,y.push(t));});});}y.forEach(function(r){r in t?r in e?s.push({type:n(t[r],e[r],r,r)?"equal":"similar",expectedIndex:r,actualIndex:r,value:t[r],expected:e[r]}):s.push({type:"remove",actualIndex:r,value:t[r]}):s.push({type:"insert",expectedIndex:r,value:e[r]});});}return s.length>0&&(s[s.length-1].last=!0),s},os=Number.isNaN||function(t){return t!==t},ss=Number.isFinite||function(t){return!("number"!=typeof t||os(t)||t===1/0||t===-1/0)},as=function(t,e){if("string"!=typeof t)throw new TypeError("Expected a string as the first argument");if(e<0||!ss(e))throw new TypeError("Expected a finite positive number");var n="";do{1&e&&(n+=t),t+=t;}while(e>>=1);return n},us=/^(?:( )+|\t+)/,cs=function(t){if("string"!=typeof t)throw new TypeError("Expected a string");var e,n,r=0,i=0,o=0,s={};t.split(/\n/g).forEach(function(t){if(t){var a,u=t.match(us);u?(a=u[0].length,u[1]?i++:r++):a=0;var c=a-o;o=a,c?(e=s[(n=c>0)?c:-c])?e[0]++:e=s[c]=[1,0]:e&&(e[1]+=+n);}});var a,u,c=Ge(s);return c?i>=r?(a="space",u=as(" ",c)):(a="tab",u=as("\t",c)):(a=null,u=""),{amount:c,type:a,indent:u}},fs="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},ls=dn.isRegExp,hs=dn.leftPad,ps=function(t){t.addType({name:"wrapperObject",identify:!1,equal:function(t,e,n){return t===e||n(this.unwrap(t),this.unwrap(e))},inspect:function(t,e,n,r){return n.append(this.prefix(n.clone(),t)),n.append(r(this.unwrap(t),e)),n.append(this.suffix(n.clone(),t)),n},diff:function(t,e,n,r,i){n.inline=!0,t=this.unwrap(t),e=this.unwrap(e);var o=r(t,e),s=this.prefix(n.clone(),t),a=this.suffix(n.clone(),t);return o&&o.inline?n.append(s).append(o).append(a):n.append(s).nl().indentLines().i().block(function(){this.append(i(t)).sp().annotationBlock(function(){this.shouldEqualError(e,i),o&&this.nl(2).append(o);});}).nl().outdentLines().append(a)}}),"function"==typeof Symbol&&t.addType({name:"Symbol",identify:function(t){return"symbol"===(void 0===t?"undefined":fs(t))},inspect:function(t,e,n,r){return n.jsKeyword("Symbol").text("(").singleQuotedString(t.toString().replace(/^Symbol\(|\)$/g,"")).text(")")}});var e;"function"==typeof Symbol&&(e=function(t,e){var n,r,i=t,o=e;if(n="symbol"===(void 0===t?"undefined":fs(t)),r="symbol"===(void 0===e?"undefined":fs(e)),n){if(!r)return 1;i=t.toString(),o=e.toString();}else if(r)return-1;return i<o?-1:i>o?1:0}),t.addType({name:"object",indent:!0,forceMultipleLines:!1,identify:function(t){return t&&"object"===(void 0===t?"undefined":fs(t))},prefix:function(t,e){var n=e.constructor,r=n&&"function"==typeof n&&n!==Object&&dn.getFunctionName(n);return r&&"Object"!==r&&t.text(r+"("),t.text("{")},suffix:function(t,e){t.text("}");var n=e.constructor,r=n&&"function"==typeof n&&n!==Object&&dn.getFunctionName(n);return r&&"Object"!==r&&t.text(")"),t},delimiter:function(t,e,n){return e<n-1&&t.text(","),t},getKeys:Object.getOwnPropertySymbols?function(t){var e=Object.keys(t),n=Object.getOwnPropertySymbols(t);return n.length>0?e.concat(n):e}:Object.keys,equal:function(t,n,r){if(t===n)return!0;if(n.constructor!==t.constructor)return!1;var i=this.getKeys(t).filter(function(e){return void 0!==t[e]}),o=this.getKeys(n).filter(function(t){return void 0!==n[t]});if(i.length!==o.length)return!1;i.sort(e),o.sort(e);for(var s=0;s<i.length;s+=1)if(i[s]!==o[s])return!1;for(var a=0;a<i.length;a+=1){var u=i[a];if(!r(t[u],n[u]))return!1}return!0},inspect:function(t,e,n,r){var i=this.getKeys(t);if(0===i.length)return this.prefix(n,t),this.suffix(n,t),n;var o=this,s=i.map(function(e,s){var a=Object.getOwnPropertyDescriptor&&Object.getOwnPropertyDescriptor(t,e),u=a&&a.get,c=a&&a.set,f=n.clone();c&&!u&&f.text("set").sp();var l=c&&!u?c:t[e],h=r(l);return l&&l._expectIt&&(h=n.clone().block(h)),f.property(e,h),f.amend(o.delimiter(n.clone(),s,i.length)),u&&c?f.sp().jsComment("/* getter/setter */"):u&&f.sp().jsComment("/* getter */"),f}),a=n.preferredWidth-2*(e===1/0?0:e)-2,u=0,c=s.length>5||s.every(function(t){return!t.isMultiline()&&(u+=t.size().width)<a}),f=n.clone();if(c){var l=0;s.forEach(function(t,e){var n=t.size();l+=n.width+1,e>0&&(1===n.height&&l<a?f.sp():(f.nl(),l=n.width),n.height>1&&(l=a)),f.append(t);});}else s.forEach(function(t,e){e>0&&f.nl(),f.append(t);});var h=this.prefix(n.clone(),t),p=this.suffix(n.clone(),t);return n.append(h),this.forceMultipleLines||f.isMultiline()?(h.isEmpty()||n.nl(),this.indent&&n.indentLines().i(),n.block(f),this.indent&&n.outdentLines(),p.isEmpty()||n.nl()):n.sp(h.isEmpty()?0:1).append(f).sp(p.isEmpty()?0:1),n.append(p)},diff:function(t,e,n,r,i,o){if(t.constructor!==e.constructor)return n.text("Mismatching constructors ").text(t.constructor&&dn.getFunctionName(t.constructor)||t.constructor).text(" should be ").text(e.constructor&&dn.getFunctionName(e.constructor)||e.constructor);n.inline=!0;var s=this.getKeys(t),a=dn.uniqueStringsAndSymbols(s,this.getKeys(e)),u=this.prefix(n.clone(),t);n.append(u).nl(u.isEmpty()?0:1),this.indent&&n.indentLines();var c=this;a.forEach(function(a,u){n.nl(u>0?1:0).i().block(function(){var f,l=n.clone(),h=!o(t[a],e[a]),p=!1;if(h)if(a in e)if(a in t){var d=r(t[a],e[a]);!d||d&&!d.inline?(l.shouldEqualError(e[a]),d&&l.nl(2).append(d)):(p=!0,f=d);}else this.error("// missing").sp(),f=n.clone().appendInspected(e[a]),p=!0;else l.error("should be removed"),p=!0;else p=!0;f||(f=i(t[a],h?1/0:null)),f.amend(c.delimiter(n.clone(),u,s.length)),p||(f=n.clone().block(f)),this.property(a,f),l.isEmpty()||this.sp().annotationBlock(l);});}),this.indent&&n.outdentLines();var f=this.suffix(n.clone(),t);return n.nl(f.isEmpty()?0:1).append(f)},similar:function(t,e){if(null===t||null===e)return!1;var n=void 0===t?"undefined":fs(t);if(n!==(void 0===e?"undefined":fs(e)))return!1;if("string"===n)return Br(t,e)<t.length/2;if("object"!==n||!t)return!1;if(dn.isArray(t)&&dn.isArray(e))return!0;var r=this.getKeys(t),i=this.getKeys(e),o=0,s=Math.round(Math.max(r.length,i.length)/2);return r.concat(i).some(function(n){return n in t&&n in e&&(o+=1),o>=s})}}),t.addType({name:"type",base:"object",identify:function(t){return t&&t._unexpectedType},inspect:function(t,e,n){return n.text("type: ").jsKeyword(t.name)}}),t.addType({name:"array-like",base:"object",identify:!1,numericalPropertiesOnly:!0,getKeys:function(t){for(var e=new Array(t.length),n=0;n<t.length;n+=1)e[n]=n;return this.numericalPropertiesOnly||Object.keys(t).forEach(function(t){dn.numericalRegExp.test(t)||e.push(t);}),e},equal:function(t,e,n){if(t===e)return!0;if(t.constructor===e.constructor&&t.length===e.length){var r;if(this.numericalPropertiesOnly){for(r=0;r<t.length;r+=1)if(!n(t[r],e[r]))return!1}else{var i=this.getKeys(t),o=this.getKeys(e);if(i.length!==o.length)return!1;for(r=0;r<i.length;r+=1)if(!n(t[i[r]],e[i[r]]))return!1}return!0}return!1},prefix:function(t){return t.text("[")},suffix:function(t){return t.text("]")},inspect:function(t,e,n,r){var i=this.prefix(n.clone(),t),o=this.suffix(n.clone(),t),s=this.getKeys(t);if(0===s.length)return n.append(i).append(o);if(1===e&&t.length>10)return n.append(i).text("...").append(o);var a=s.map(function(e){var i;return i=e in t?r(t[e]):dn.numericalRegExp.test(e)?n.clone():r(void 0),n.clone().property(e,i,!0)}),u=Ao-Math.min(Ao,e),c=n.preferredWidth-20-u*n.indentationWidth-2,f=0,l=this.forceMultipleLines||a.some(function(t){if(t.isMultiline())return!0;var e=t.size();return(f+=e.width)>c}),h=this;return a.forEach(function(t,e){t.amend(h.delimiter(n.clone(),e,s.length));}),l?(n.append(i),i.isEmpty()||n.nl(),this.indent&&n.indentLines(),a.forEach(function(t,e){n.nl(e>0?1:0).i().block(t);}),this.indent&&n.outdentLines(),o.isEmpty()||n.nl(),n.append(o)):(n.append(i).sp(i.isEmpty()?0:1),a.forEach(function(t,e){n.append(t),e===a.length-1||n.sp();}),n.sp(o.isEmpty()?0:1).append(o))},diffLimit:512,diff:function(t,e,n,r,i,o){if(n.inline=!0,Math.max(t.length,e.length)>this.diffLimit)return n.jsComment("Diff suppressed due to size > "+this.diffLimit),n;if(t.constructor!==e.constructor)return this.baseType.diff(t,e,n);var s=this.prefix(n.clone(),t);n.append(s).nl(s.isEmpty()?0:1),this.indent&&n.indentLines();var a=this,u=is(t,e,o,function(t,e){return a.similar(t,e)},!a.numericalPropertiesOnly&&dn.uniqueNonNumericalStringsAndSymbols(this.getKeys(t),this.getKeys(e))),c=u.reduce(function(t,e,n){return"insert"===e.type?t:n},-1),f=dn.packArrows(u);n.arrowsAlongsideChangeOutputs(f,u.map(function(t,e){var o=a.delimiter(n.clone(),e,c+1);return"moveTarget"===t.type?n.clone():n.clone().block(function(){"moveSource"===t.type?this.property(t.actualIndex,i(t.value),!0).amend(o.sp()).error("// should be moved"):"insert"===t.type?this.annotationBlock(function(){this.error("missing ").block(function(){var e=void 0!==t.actualIndex?t.actualIndex:t.expectedIndex;this.property(e,i(t.value),!0);});}):"remove"===t.type?this.block(function(){this.property(t.actualIndex,i(t.value),!0).amend(o.sp()).error("// should be removed");}):"equal"===t.type?this.block(function(){this.property(t.actualIndex,i(t.value),!0).amend(o);}):this.block(function(){var e=r(t.value,t.expected);this.property(t.actualIndex,n.clone().block(function(){e&&e.inline?this.append(e.amend(o)):e?this.append(i(t.value).amend(o.sp())).annotationBlock(function(){this.shouldEqualError(t.expected,i).nl(2).append(e);}):this.append(i(t.value).amend(o.sp())).annotationBlock(function(){this.shouldEqualError(t.expected,i);});}),!0);});})})),this.indent&&n.outdentLines();var l=this.suffix(n.clone(),t);return n.nl(l.isEmpty()?0:1).append(l)}}),t.addType({name:"array",base:"array-like",numericalPropertiesOnly:!1,identify:function(t){return dn.isArray(t)}}),t.addType({name:"arguments",base:"array-like",prefix:function(t){return t.text("arguments(","cyan")},suffix:function(t){return t.text(")","cyan")},identify:function(t){return"[object Arguments]"===Object.prototype.toString.call(t)}});var n=["message","name","description","line","column","sourceId","sourceURL","stack","stackArray"].reduce(function(t,e){return t[e]=!0,t},{});t.addType({base:"object",name:"Error",identify:function(t){return dn.isError(t)},getKeys:function(t){var e=this.baseType.getKeys(t).filter(function(t){return!n[t]});return e.unshift("message"),e},unwrap:function(t){return this.getKeys(t).reduce(function(e,n){return e[n]=t[n],e},{})},equal:function(t,e,n){return t===e||n(t.message,e.message)&&this.baseType.equal(t,e)},inspect:function(t,e,n,r){n.errorName(t).text("(");var i=this.getKeys(t);return 1===i.length&&"message"===i[0]?""!==t.message&&n.append(r(t.message)):n.append(r(this.unwrap(t),e)),n.text(")")},diff:function(t,e,n,r){return t.constructor!==e.constructor?n.text("Mismatching constructors ").errorName(t).text(" should be ").errorName(e):((n=r(this.unwrap(t),this.unwrap(e)))&&((n=n.clone().errorName(t).text("(").append(n).text(")")).inline=!1),n)}});var r=["output","_isUnexpected","htmlMessage","_hasSerializedErrorMessage","expect","assertion","originalError"].reduce(function(t,e){return t[e]=!0,t},{});t.addType({base:"Error",name:"UnexpectedError",identify:function(t){return t&&"object"===(void 0===t?"undefined":fs(t))&&t._isUnexpected&&this.baseType.identify(t)},getKeys:function(t){return this.baseType.getKeys(t).filter(function(t){return!r[t]})},inspect:function(t,e,n){n.jsFunctionName(this.name).text("(");var r=t.getErrorMessage(n);return r.isMultiline()?n.nl().indentLines().i().block(r).nl():n.append(r),n.text(")")}}),t.addType({name:"date",identify:function(t){return"[object Date]"===Object.prototype.toString.call(t)},equal:function(t,e){return t.getTime()===e.getTime()},inspect:function(t,e,n,r){var i=t.toUTCString().replace(/UTC/,"GMT"),o=t.getUTCMilliseconds();if(o>0){for(var s=String(o);s.length<3;)s="0"+s;i=i.replace(" GMT","."+s+" GMT");}return n.jsKeyword("new").sp().text("Date(").append(r(i).text(")"))}}),t.addType({base:"any",name:"function",identify:function(t){return"function"==typeof t},getKeys:Object.keys,equal:function(t,e){return t===e},inspect:function(t,e,n,r){var i,o,s,a=Function.prototype.toString.call(t).replace(/\r\n?|\n\r?/g,"\n"),u=dn.getFunctionName(t)||"",c=a.match(/^\s*((?:async )?\s*(?:\S+\s*=>|\([^\)]*\)\s*=>|function \w*?\s*\([^\)]*\)))([\s\S]*)$/);if(c){"function ()"===(i=c[1])&&u&&(i="function "+u+"()");var f,l=(o=c[2]).match(/^(\s*\{)([\s\S]*?)([ ]*)\}\s*$/),h=!0,p="}";if(l?(f=l[1],o=l[2],1===(s=l[3]||"").length&&(p=" }")):(l=o.match(/^(\s*)([\s\S]*?)([ ]*)\s*$/))&&(f=l[1],h=!1,o=l[2],s=l[3]||"",p=""),/\n/.test(o)&&!/\\\n/.test(o)){o=o.replace(new RegExp("^ {"+s.length+"}","mg"),"");var d=cs(o);o=o.replace(new RegExp("^(?:"+d.indent+")+","mg"),function(t){return dn.leftPad("",t.length/d.amount*n.indentationWidth," ")});}u&&"anonymous"!==u||(u=""),/^\s*\[native code\]\s*$/.test(o)?(o=" /* native code */ ",p="}"):/^\s*$/.test(o)?o="":/^\s*[^\r\n]{1,30}\s*$/.test(o)&&-1===o.indexOf("//")&&h?(o=" "+o.trim()+" ",p="}"):o=o.replace(/^((?:.*\n){3}( *).*\n)[\s\S]*?\n[\s\S]*?\n((?:.*\n){3})$/,"$1$2// ... lines removed ...\n$3"),o=l?f+o+p:o.replace(/[ ]*$/,"");}else i="function "+u+"( /*...*/ ) ",o="{ /*...*/ }";return n.code(i+o,"javascript")}}),t.addType({base:"function",name:"expect.it",identify:function(t){return"function"==typeof t&&t._expectIt},inspect:function(t,e,n,r){n.text("expect.it(");var i=!1;return t._expectations.forEach(function(e,o){e!==t._OR?(i?n.text(")\n      .or("):0<o&&n.text(")\n        .and("),Array.prototype.slice.call(e).forEach(function(t,e){0<e&&n.text(", "),n.append(r(t));}),i=!1):i=!0;}),n.amend(")")}}),t.addType({name:"Promise",base:"object",identify:function(t){return t&&this.baseType.identify(t)&&"function"==typeof t.then},inspect:function(t,e,n,r){if(n.jsFunctionName("Promise"),t.isPending&&t.isPending())n.sp().yellow("(pending)");else if(t.isFulfilled&&t.isFulfilled()){if(n.sp().green("(fulfilled)"),t.value){var i=t.value();void 0!==i&&n.sp().text("=>").sp().append(r(i));}}else t.isRejected&&t.isRejected()&&(n.sp().red("(rejected)"),void 0!==t.reason()&&n.sp().text("=>").sp().append(r(t.reason())));return n}}),t.addType({name:"regexp",base:"object",identify:ls,equal:function(t,e){return t===e||t.source===e.source&&t.global===e.global&&t.ignoreCase===e.ignoreCase&&t.multiline===e.multiline},inspect:function(t,e,n){return n.jsRegexp(t)},diff:function(t,e,n,r,i){return n.inline=!1,n.stringDiff(String(t),String(e),{type:"Chars",markUpSpecialCharacters:!0})}}),t.addType({name:"binaryArray",base:"array-like",digitWidth:2,hexDumpWidth:16,identify:!1,prefix:function(t){return t.code(this.name+"([","javascript")},suffix:function(t){return t.code("])","javascript")},equal:function(t,e){if(t===e)return!0;if(t.length!==e.length)return!1;for(var n=0;n<t.length;n+=1)if(t[n]!==e[n])return!1;return!0},hexDump:function(t,e){var n="";"number"==typeof e&&0!==e||(e=t.length);for(var r=0;r<e;r+=this.hexDumpWidth){n.length>0&&(n+="\n");for(var i="",o=" │",s=0;s<this.hexDumpWidth;s+=1)if(r+s<e){var a=t[r+s];i+=hs(a.toString(16).toUpperCase(),this.digitWidth,"0")+" ",o+=String.fromCharCode(a).replace(/\n/g,"␊").replace(/\r/g,"␍");}else 2===this.digitWidth&&(i+="   ");2===this.digitWidth?n+=i+o+"│":n+=i.replace(/\s+$/,"");}return n},inspect:function(t,e,n){this.prefix(n,t);for(var r="",i=0;i<Math.min(this.hexDumpWidth,t.length);i+=1){i>0&&(r+=", ");var o=t[i];r+="0x"+hs(o.toString(16).toUpperCase(),this.digitWidth,"0");}return t.length>this.hexDumpWidth&&(r+=" /* "+(t.length-this.hexDumpWidth)+" more */ "),n.code(r,"javascript"),this.suffix(n,t),n},diffLimit:512,diff:function(t,e,n,r,i){return n.inline=!1,Math.max(t.length,e.length)>this.diffLimit?n.jsComment("Diff suppressed due to size > "+this.diffLimit):n.stringDiff(this.hexDump(t),this.hexDump(e),{type:"Chars",markUpSpecialCharacters:!1}).replaceText(/[\x00-\x1f\x7f-\xff␊␍]/g,".").replaceText(/[│ ]/g,function(t,e){this.text(e);}),n}}),[8,16,32].forEach(function(e){["Int","Uint"].forEach(function(n){var r=n+e+"Array",i=on[r];void 0!==i&&t.addType({name:r,base:"binaryArray",hexDumpWidth:128/e,digitWidth:e/4,identify:function(t){return t instanceof i}});},this);},this),void 0!==Gt&&t.addType({name:"Buffer",base:"binaryArray",identify:qe}),t.addType({name:"string",identify:function(t){return"string"==typeof t},inspect:function(t,e,n){return n.singleQuotedString(t)},diffLimit:4096,diff:function(t,e,n,r,i){return Math.max(t.length,e.length)>this.diffLimit?(n.jsComment("Diff suppressed due to size > "+this.diffLimit),n):(n.stringDiff(t,e,{type:"WordsWithSpace",markUpSpecialCharacters:!0}),n.inline=!1,n)}}),t.addType({name:"number",identify:function(t){return"number"==typeof t&&!isNaN(t)},inspect:function(t,e,n){return t=0===t&&1/t==-1/0?"-0":String(t),n.jsNumber(String(t))}}),t.addType({name:"NaN",identify:function(t){return"number"==typeof t&&isNaN(t)},inspect:function(t,e,n){return n.jsPrimitive(t)}}),t.addType({name:"boolean",identify:function(t){return"boolean"==typeof t},inspect:function(t,e,n){return n.jsPrimitive(t)}}),t.addType({name:"undefined",identify:function(t){return void 0===t},inspect:function(t,e,n){return n.jsPrimitive(t)}}),t.addType({name:"null",identify:function(t){return null===t},inspect:function(t,e,n){return n.jsPrimitive(t)}}),t.addType({name:"assertion",identify:function(t){return t instanceof sn}});},ds=nn,ys=1e3;nn.InsertDiff=Xe,nn.RemoveDiff=Ze,nn.MoveDiff=tn,Xe.prototype.type="insert",Xe.prototype.toJSON=function(){return{type:this.type,index:this.index,values:this.values}},Ze.prototype.type="remove",Ze.prototype.toJSON=function(){return{type:this.type,index:this.index,howMany:this.howMany}},tn.prototype.type="move",tn.prototype.toJSON=function(){return{type:this.type,from:this.from,to:this.to,howMany:this.howMany}};var gs=1e3,vs=function(t,e,n,r,i,o){"function"==typeof i&&(o=i,i=!1);for(var s=new Array(t.length),a=0;a<t.length;a+=1)s[a]={type:"similar",actualIndex:a,value:t[a]};r=r||function(t,e,n,r,i){return i(!1)},ds([].concat(t),[].concat(e),function(t,e,i,o,s){n(t,e,i,o,function(n){if(n)return s(!0);r(t,e,i,o,function(t){return s(t)});});},function(a){function u(t){var e,n=0;for(e=0;e<s.length&&n<t;e+=1)"remove"!==s[e].type&&"moveSource"!==s[e].type&&n++;return e}var c=0;a.filter(function(t){return"remove"===t.type}).forEach(function(t){var e=c+t.index;s.slice(e,t.howMany+e).forEach(function(t){t.type="remove";}),c+=t.howMany;}),a.filter(function(t){return"move"===t.type}).forEach(function(t){var e=u(t.from+1)-1,n=s.slice(e,t.howMany+e),r=n.map(function(t){return rn({},t,{last:!1,type:"moveTarget"})});n.forEach(function(t){t.type="moveSource";});var i=u(t.to);Array.prototype.splice.apply(s,[i,0].concat(r));}),a.filter(function(t){return"insert"===t.type}).forEach(function(t){for(var e=new Array(t.values.length),n=0;n<t.values.length;n+=1)e[n]={type:"insert",value:t.values[n]};Array.prototype.splice.apply(s,[u(t.index),0].concat(e));});var f=0;s.forEach(function(t,n){var r=t.type;"remove"===r||"moveSource"===r?f-=1:"similar"===r&&(t.expected=e[f+n],t.expectedIndex=f+n);});var l=s.reduce(function(t,e){return"similar"===e.type||"moveSource"===e.type||"moveTarget"===e.type?t:t+1},0),h=Math.max(t.length,e.length),p=function(i,o,s,a){if(i>=h||o>l)return setTimeout(function(){a(o);},0);r(t[i],e[i],i,i,function(r){if(!r)return o+=1,0===s?setTimeout(function(){p(i+1,o,gs,a);}):p(i+1,o,s-1,a);n(t[i],e[i],i,i,function(t){return t||(o+=1),0===s?setTimeout(function(){p(i+1,o,gs,a);}):p(i+1,o,s-1,a)});});};p(0,0,gs,function(r){if(r<=l){s=[];var a;for(a=0;a<Math.min(t.length,e.length);a+=1)s.push({type:"similar",actualIndex:a,expectedIndex:a,value:t[a],expected:e[a]});if(t.length<e.length)for(;a<Math.max(t.length,e.length);a+=1)s.push({type:"insert",value:e[a]});else for(;a<Math.max(t.length,e.length);a+=1)s.push({type:"remove",value:t[a]});}var u=function(t,e,r){if(t>=s.length)return r();var i=s[t];return"similar"===i.type?n(i.value,i.expected,i.actualIndex,i.expectedIndex,function(n){if(n&&(s[t].type="equal"),0===e)return setTimeout(function(){u(t+1,gs,r);});u(t+1,e-1,r);}):0===e?setTimeout(function(){u(t+1,gs,r);}):u(t+1,e-1,r)};if(i){var c;if(Array.isArray(i))c=i;else{var f={};c=[],[t,e].forEach(function(t){Object.keys(t).forEach(function(t){/^(?:0|[1-9][0-9]*)$/.test(t)||f[t]||(f[t]=!0,c.push(t));}),Object.getOwnPropertySymbols&&Object.getOwnPropertySymbols(t).forEach(function(t){f[t]||(f[t]=!0,c.push(t));});});}c.forEach(function(n){n in t?n in e?s.push({type:"similar",expectedIndex:n,actualIndex:n,value:t[n],expected:e[n]}):s.push({type:"remove",actualIndex:n,value:t[n]}):s.push({type:"insert",expectedIndex:n,value:e[n]});});}u(0,gs,function(){s.length>0&&(s[s.length-1].last=!0),o(s);});});});},ms="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},bs=dn.objectIs,_s=dn.isRegExp,ws=dn.extend,Es=function(t){function e(t,e,n){var r=t.getDiffMethod();if(r)return function(t){e.prefix.call(e,t,n);var i=r.apply(this,arguments);return e.suffix.call(e,t,n),i}}function n(t,e){function n(){return t.apply(this,e)}return n.prototype=t.prototype,new n}t.addAssertion("<any> [not] to be (ok|truthy)",function(t,e){!!e===!!t.flags.not&&t.fail();}),t.addAssertion("<any> [not] to be (ok|truthy) <string>",function(t,e,n){!!e===!!t.flags.not&&t.fail({errorMode:"bubble",message:n});}),t.addAssertion("<any> [not] to be <any>",function(t,e,n){t(bs(e,n),"[not] to be truthy");}),t.addAssertion("<string> [not] to be <string>",function(t,e,n){t(e,"[not] to equal",n);}),t.addAssertion("<boolean> [not] to be true",function(t,e){t(e,"[not] to be",!0);}),t.addAssertion("<boolean> [not] to be false",function(t,e){t(e,"[not] to be",!1);}),t.addAssertion("<any> [not] to be falsy",function(t,e){t(e,"[!not] to be truthy");}),t.addAssertion("<any> [not] to be falsy <string>",function(t,e,n){!!e!==!!t.flags.not&&t.fail({errorMode:"bubble",message:n});}),t.addAssertion("<any> [not] to be null",function(t,e){t(e,"[not] to be",null);}),t.addAssertion("<any> [not] to be undefined",function(t,e){t(void 0===e,"[not] to be truthy");}),t.addAssertion("<any> to be defined",function(t,e){t(e,"not to be undefined");}),t.addAssertion("<number|NaN> [not] to be NaN",function(t,e){t(isNaN(e),"[not] to be truthy");}),t.addAssertion("<number> [not] to be close to <number> <number?>",function(t,e,n,r){t.errorMode="bubble","number"!=typeof r&&(r=1e-9),t.withError(function(){t(Math.abs(e-n),"[not] to be less than or equal to",r);},function(i){t.fail(function(i){i.error("expected ").appendInspected(e).sp().error(t.testDescription).sp().appendInspected(n).sp().text("(epsilon: ").jsNumber(r.toExponential()).text(")");});});}),t.addAssertion("<any> [not] to be (a|an) <type>",function(t,e,n){t.argsOutput[0]=function(t){t.text(n.name);},t(n.identify(e),"[not] to be true");}),t.addAssertion("<any> [not] to be (a|an) <string>",function(t,e,n){n=/^reg(?:exp?|ular expression)$/.test(n)?"regexp":n,t.argsOutput[0]=function(t){t.jsString(n);},t.getType(n)||(t.errorMode="nested",t.fail(function(t){t.error("Unknown type:").sp().jsString(n);})),t(t.subjectType.is(n),"[not] to be truthy");}),t.addAssertion("<any> [not] to be (a|an) <function>",function(t,e,n){var r=dn.getFunctionName(n);r&&(t.argsOutput[0]=function(t){t.text(r);}),t(e instanceof n,"[not] to be truthy");}),t.addAssertion("<any> [not] to be one of <array>",function(t,e,n){for(var r=!1,i=0;i<n.length;i+=1)r=r||bs(e,n[i]);r===t.flags.not&&t.fail();}),t.addAssertion("<any> [not] to be an (object|array)",function(t,e){t(e,"[not] to be an",t.alternations[0]);}),t.addAssertion("<any> [not] to be a (boolean|number|string|function|regexp|regex|regular expression|date)",function(t,e){t(e,"[not] to be a",t.alternations[0]);}),t.addAssertion("<string> to be (the empty|an empty|a non-empty) string",function(t,e){t(e,"a non-empty"===t.alternations[0]?"not to be empty":"to be empty");}),t.addAssertion("<array-like> to be (the empty|an empty|a non-empty) array",function(t,e){t(e,"a non-empty"===t.alternations[0]?"not to be empty":"to be empty");}),t.addAssertion("<string> to match <regexp>",function(t,e,n){return t.withError(function(){var r=e.match(n);return t(r,"to be truthy"),r},function(e){e.label="should match",t.fail(e);})}),t.addAssertion("<string> not to match <regexp>",function(t,e,n){return t.withError(function(){t(n.test(e),"to be false");},function(r){t.fail({label:"should not match",diff:function(t){function r(n){n>i&&(t.text(e.substring(i,n)),i=n);}t.inline=!1;var i=0;return e.replace(new RegExp(n.source,"g"),function(e,n){r(n),i+=e.length,t.removedHighlight(e);}),r(e.length),t}});})}),t.addAssertion("<object|function> [not] to have own property <string>",function(t,e,n){return t(e.hasOwnProperty(n),"[not] to be truthy"),e[n]}),t.addAssertion("<object|function> [not] to have (enumerable|configurable|writable) property <string>",function(t,e,n){var r=t.alternations[0];return t(Object.getOwnPropertyDescriptor(e,n)[r],"[not] to be truthy"),e[n]}),t.addAssertion("<object|function> [not] to have property <string>",function(t,e,n){return t(e[n],"[!not] to be undefined"),e[n]}),t.addAssertion("<object|function> to have [own] property <string> <any>",function(t,e,n,r){return t(e,"to have [own] property",n).then(function(e){return t.argsOutput=function(){this.appendInspected(n).sp().error("with a value of").sp().appendInspected(r);},t(e,"to equal",r),e})}),t.addAssertion("<object|function> [not] to have [own] properties <array>",function(t,e,n){var r=[];n.forEach(function(t){"string"!=typeof t&&"number"!=typeof t&&r.push(t);}),r.length>0&&(t.errorMode="nested",t.fail(function(){this.error("All expected properties must be passed as strings or numbers, but these are not:").indentLines(),r.forEach(function(t){this.nl().i().appendInspected(t);},this),this.outdentLines();})),n.forEach(function(n){t(e,"[not] to have [own] property",String(n));});}),t.addAssertion("<object|function> to have [own] properties <object>",function(t,e,n){t.withError(function(){Object.keys(n).forEach(function(r){var i=n[r];void 0===i?t(e,"not to have [own] property",r):t(e,"to have [own] property",r,i);});},function(r){t.fail({diff:function(r,i){r.inline=!1;var o=ws({},n),s={},a=t.findTypeOf(e).getKeys(e);for(var u in e)e.hasOwnProperty(u)||a.push(u);return a.forEach(function(r){t.flags.own&&!e.hasOwnProperty(r)||r in n||(o[r]=e[r]),t.flags.own&&!e.hasOwnProperty(r)||r in s||(s[r]=e[r]);}),dn.wrapConstructorNameAroundOutput(i(s,o),e)}});});}),t.addAssertion("<string|array-like> [not] to have length <number>",function(t,e,n){t.flags.not||(t.errorMode="nested"),t(e.length,"[not] to be",n);}),t.addAssertion("<string|array-like> [not] to be empty",function(t,e){t(e,"[not] to have length",0);}),t.addAssertion("<string|array-like|object> to be non-empty",function(t,e){t(e,"not to be empty");}),t.addAssertion("<object> to [not] [only] have keys <array>",function(t,e,n){var r={},i=t.findTypeOf(e).getKeys(e);if(i.forEach(function(t){r[t]=!0;}),!t.flags.not||0!==n.length){var o=n.every(function(t){return r[t]});t.flags.only?(t(o,"to be truthy"),t.withError(function(){t(i.length===n.length,"[not] to be truthy");},function(r){t.fail({diff:!t.flags.not&&function(r,o,s,a){r.inline=!0;var u={};n.forEach(function(t){u[t]=!0;});var c=t.findTypeOf(e),f=c.is("array-like");return c.prefix(r,e),r.nl().indentLines(),i.forEach(function(t,n){r.i().block(function(){this.property(t,s(e[t]),f),c.delimiter(this,n,i.length),u[t]||this.sp().annotationBlock(function(){this.error("should be removed");});}).nl();}),r.outdentLines(),c.suffix(r,e),r}});})):t(o,"[not] to be truthy");}}),t.addAssertion("<object> [not] to be empty",function(t,e){if(t.flags.not&&!t.findTypeOf(e).getKeys(e).length)return t.fail();t(e,"to [not] only have keys",[]);}),t.addAssertion("<object> not to have keys <array>",function(t,e,n){t(e,"to not have keys",n);}),t.addAssertion("<object> not to have key <string>",function(t,e,n){t(e,"to not have keys",[n]);}),t.addAssertion("<object> not to have keys <string+>",function(t,e,n){t(e,"to not have keys",Array.prototype.slice.call(arguments,2));}),t.addAssertion("<object> to [not] [only] have key <string>",function(t,e,n){t(e,"to [not] [only] have keys",[n]);}),t.addAssertion("<object> to [not] [only] have keys <string+>",function(t,e){t(e,"to [not] [only] have keys",Array.prototype.slice.call(arguments,2));}),t.addAssertion("<string> [not] to contain <string+>",function(t,e){var n=Array.prototype.slice.call(arguments,2);n.forEach(function(e){if(""===e)throw new Error("The '"+t.testDescription+"' assertion does not support the empty string")}),t.withError(function(){n.forEach(function(n){t(-1!==e.indexOf(n),"[not] to be truthy");});},function(r){t.fail({diff:function(r){function i(t){t>o&&(r.text(e.substring(o,t)),o=t);}r.inline=!1;var o=0;if(t.flags.not)e.replace(new RegExp(n.map(function(t){return dn.escapeRegExpMetaChars(t)}).join("|"),"g"),function(t,e){i(e),o+=t.length,r.removedHighlight(t);}),i(e.length);else{var s=[];n.forEach(function(t){for(var n=t,r=!1;n.length>1;){var i=!1;o=-1;var a;do{-1!==(a=e.indexOf(n,o+1))&&(i=!0,s.push({startIndex:a,endIndex:a+n.length,partial:r})),o=a;}while(-1!==o);if(i)break;n=t.substr(0,n.length-1),r=!0;}}),o=0,s.sort(function(t,e){return t.startIndex-e.startIndex}).forEach(function(t){i(t.startIndex);var n=Math.max(t.startIndex,o);t.endIndex>n&&(t.partial?r.partialMatch(e.substring(n,t.endIndex)):r.match(e.substring(n,t.endIndex)),o=t.endIndex);}),i(e.length);}return r}});});}),t.addAssertion("<array-like> [not] to contain <any+>",function(t,e){var n=Array.prototype.slice.call(arguments,2);t.withError(function(){n.forEach(function(n){t(e&&Array.prototype.some.call(e,function(e){return t.equal(e,n)}),"[not] to be truthy");});},function(r){t.fail({diff:t.flags.not&&function(t,r,i,o){return r(e,Array.prototype.filter.call(e,function(t){return!n.some(function(e){return o(t,e)})}))}});});}),t.addAssertion("<string> [not] to begin with <string>",function(t,e,n){if(""===n)throw new Error("The '"+t.testDescription+"' assertion does not support a prefix of the empty string");t.withError(function(){t(e.substr(0,n.length),"[not] to equal",n);},function(r){t.fail({diff:function(r){if(r.inline=!1,t.flags.not)r.removedHighlight(n).text(e.substr(n.length));else{for(var i=0;e[i]===n[i];)i+=1;if(0===i)return null;r.partialMatch(e.substr(0,i)).text(e.substr(i));}return r}});});}),t.addAssertion("<string> [not] to end with <string>",function(t,e,n){if(""===n)throw new Error("The '"+t.testDescription+"' assertion does not support a suffix of the empty string");t.withError(function(){t(e.substr(-n.length),"[not] to equal",n);},function(r){t.fail({diff:function(r){if(r.inline=!1,t.flags.not)r.text(e.substr(0,e.length-n.length)).removedHighlight(n);else{for(var i=0;e[e.length-1-i]===n[n.length-1-i];)i+=1;if(0===i)return null;r.text(e.substr(0,e.length-i)).partialMatch(e.substr(e.length-i,e.length));}return r}});});}),t.addAssertion("<number> [not] to be finite",function(t,e){t(isFinite(e),"[not] to be truthy");}),t.addAssertion("<number> [not] to be infinite",function(t,e){t(!isNaN(e)&&!isFinite(e),"[not] to be truthy");}),t.addAssertion("<number> [not] to be within <number> <number>",function(t,e,n,r){t.argsOutput=function(t){t.appendInspected(n).text("..").appendInspected(r);},t(e>=n&&e<=r,"[not] to be truthy");}),t.addAssertion("<string> [not] to be within <string> <string>",function(t,e,n,r){t.argsOutput=function(t){t.appendInspected(n).text("..").appendInspected(r);},t(e>=n&&e<=r,"[not] to be truthy");}),t.addAssertion("<number> [not] to be (less than|below) <number>",function(t,e,n){t(e<n,"[not] to be truthy");}),t.addAssertion("<string> [not] to be (less than|below) <string>",function(t,e,n){t(e<n,"[not] to be truthy");}),t.addAssertion("<number> [not] to be less than or equal to <number>",function(t,e,n){t(e<=n,"[not] to be truthy");}),t.addAssertion("<string> [not] to be less than or equal to <string>",function(t,e,n){t(e<=n,"[not] to be truthy");}),t.addAssertion("<number> [not] to be (greater than|above) <number>",function(t,e,n){t(e>n,"[not] to be truthy");}),t.addAssertion("<string> [not] to be (greater than|above) <string>",function(t,e,n){t(e>n,"[not] to be truthy");}),t.addAssertion("<number> [not] to be greater than or equal to <number>",function(t,e,n){t(e>=n,"[not] to be truthy");}),t.addAssertion("<string> [not] to be greater than or equal to <string>",function(t,e,n){t(e>=n,"[not] to be truthy");}),t.addAssertion("<number> [not] to be positive",function(t,e){t(e,"[not] to be greater than",0);}),t.addAssertion("<number> [not] to be negative",function(t,e){t(e,"[not] to be less than",0);}),t.addAssertion("<any> to equal <any>",function(t,e,n){t.withError(function(){t(t.equal(n,e),"to be truthy");},function(r){t.fail({label:"should equal",diff:function(t,r){return r(e,n)}});});}),t.addAssertion("<any> not to equal <any>",function(t,e,n){t(t.equal(n,e),"to be falsy");}),t.addAssertion("<function> to error",function(t,e){return t.promise(function(){return e()}).then(function(){t.fail();},function(t){return t})}),t.addAssertion("<function> to error [with] <any>",function(t,e,n){return t(e,"to error").then(function(e){return t.errorMode="nested",t.withError(function(){return e.isUnexpected&&("string"==typeof n||_s(n))?t(e,"to have message",n):t(e,"to satisfy",n)},function(t){throw t.originalError=e,t})})}),t.addAssertion("<function> not to error",function(t,e){var n=!1;return t.promise(function(){try{return e()}catch(t){throw n=!0,t}}).caught(function(e){t.errorMode="nested",t.fail({output:function(t){t.error(n?"threw":"returned promise rejected with").error(": ").appendErrorMessage(e);},originalError:e});})}),t.addAssertion("<function> not to throw",function(t,e){var n,r=!1;try{e();}catch(t){n=t,r=!0;}r&&(t.errorMode="nested",t.fail({output:function(t){t.error("threw: ").appendErrorMessage(n);},originalError:n}));}),t.addAssertion("<function> to (throw|throw error|throw exception)",function(t,e){try{e();}catch(t){return t}t.errorMode="nested",t.fail("did not throw");}),t.addAssertion("<function> to throw (a|an) <function>",function(t,e,n){var r=dn.getFunctionName(n);return r&&(t.argsOutput[0]=function(t){t.jsFunctionName(r);}),t.errorMode="nested",t(e,"to throw").then(function(e){t(e,"to be a",n);})}),t.addAssertion("<function> to (throw|throw error|throw exception) <any>",function(t,e,n){return t.errorMode="nested",t(e,"to throw").then(function(e){var r=e&&e._isUnexpected;return t.errorMode="nested",t.withError(function(){return r&&("string"==typeof n||_s(n))?t(e.getErrorMessage("text").toString(),"to satisfy",n):t(e,"to satisfy",n)},function(t){throw t.originalError=e,t})})}),t.addAssertion("<function> to have arity <number>",function(t,e,n){t(e.length,"to equal",n);}),t.addAssertion(["<object> to have values [exhaustively] satisfying <any>","<object> to have values [exhaustively] satisfying <assertion>","<object> to be (a map|a hash|an object) whose values [exhaustively] satisfy <any>","<object> to be (a map|a hash|an object) whose values [exhaustively] satisfy <assertion>"],function(t,e,n){t.errorMode="nested",t(e,"not to be empty"),t.errorMode="bubble";var r={};return t.subjectType.getKeys(e).forEach(function(e,i){r[e]="string"==typeof n?function(e){return t.shift(e)}:"function"==typeof n?function(e){return n._expectIt?n(e,t.context):n(e,i)}:n;}),t.withError(function(){return t(e,"to [exhaustively] satisfy",r)},function(e){t.fail({message:function(e){e.append(t.standardErrorMessage(e.clone(),{compact:!0}));},diff:function(t){var n=e.getDiff({output:t});return n.inline=!0,n}});})}),t.addAssertion(["<array-like> to have items [exhaustively] satisfying <any>","<array-like> to have items [exhaustively] satisfying <assertion>","<array-like> to be an array whose items [exhaustively] satisfy <any>","<array-like> to be an array whose items [exhaustively] satisfy <assertion>"],function(t,e){var n=Array.prototype.slice.call(arguments,2);return t.errorMode="nested",t(e,"not to be empty"),t.errorMode="bubble",t.withError(function(){return t.apply(t,[e,"to have values [exhaustively] satisfying"].concat(n))},function(e){t.fail({message:function(e){e.append(t.standardErrorMessage(e.clone(),{compact:!0}));},diff:function(t){var n=e.getDiff({output:t});return n.inline=!0,n}});})}),t.addAssertion(["<object> to have keys satisfying <any>","<object> to have keys satisfying <assertion>","<object> to be (a map|a hash|an object) whose (keys|properties) satisfy <any>","<object> to be (a map|a hash|an object) whose (keys|properties) satisfy <assertion>"],function(t,e){t.errorMode="nested",t(e,"not to be empty"),t.errorMode="default";var n=t.subjectType.getKeys(e),r=Array.prototype.slice.call(arguments,2);return t.apply(t,[n,"to have items satisfying"].concat(r))}),t.addAssertion(["<object> to have a value [exhaustively] satisfying <any>","<object> to have a value [exhaustively] satisfying <assertion>"],function(t,e,n){t.errorMode="nested",t(e,"not to be empty"),t.errorMode="bubble";var r=t.subjectType.getKeys(e);return t.promise.any(r.map(function(r,i){var o;return o="string"==typeof n?function(e){return t.shift(e)}:"function"==typeof n?function(t){return n(t,i)}:n,t.promise(function(){return t(e[r],"to [exhaustively] satisfy",o)})})).catch(function(e){return t.fail(function(e){e.append(t.standardErrorMessage(e.clone(),{compact:!0}));})})}),t.addAssertion(["<array-like> to have an item [exhaustively] satisfying <any>","<array-like> to have an item [exhaustively] satisfying <assertion>"],function(t,e){t.errorMode="nested",t(e,"not to be empty"),t.errorMode="bubble";var n=Array.prototype.slice.call(arguments,2);return t.withError(function(){return t.apply(t,[e,"to have a value [exhaustively] satisfying"].concat(n))},function(e){t.fail(function(e){e.append(t.standardErrorMessage(e.clone(),{compact:!0}));});})}),t.addAssertion("<object> to be canonical",function(t,e){var n=[];!function e(r){var i;for(i=0;i<n.length;i+=1)if(n[i]===r)return;if(r&&"object"===(void 0===r?"undefined":ms(r))){var o=Object.keys(r);for(i=0;i<o.length-1;i+=1)t(o[i],"to be less than",o[i+1]);n.push(r),o.forEach(function(t){e(r[t]);}),n.pop();}}(e);}),t.addAssertion("<Error> to have message <any>",function(t,e,n){return t.errorMode="nested",t(e.isUnexpected?e.getErrorMessage("text").toString():e.message,"to satisfy",n)}),t.addAssertion("<Error> to [exhaustively] satisfy <Error>",function(t,e,n){t(e.constructor,"to be",n.constructor);var r=t.argTypes[0].unwrap(n);return t.withError(function(){return t(e,"to [exhaustively] satisfy",r)},function(n){t.fail({diff:function(n,i){n.inline=!1;var o=t.subjectType.unwrap(e);return dn.wrapConstructorNameAroundOutput(i(o,r),e)}});})}),t.addAssertion("<Error> to [exhaustively] satisfy <object>",function(t,e,n){var r=t.argTypes[0],i=t.subjectType.getKeys(e),o=r.getKeys(n),s={};return i.concat(o).forEach(function(t){s[t]=e[t];}),t(s,"to [exhaustively] satisfy",n)}),t.addAssertion("<Error> to [exhaustively] satisfy <regexp|string>",function(t,e,n){return t(e.message,"to [exhaustively] satisfy",n)}),t.addAssertion("<Error> to [exhaustively] satisfy <any>",function(t,e,n){return t(e.message,"to [exhaustively] satisfy",n)}),t.addAssertion("<binaryArray> to [exhaustively] satisfy <expect.it>",function(t,e,n){return t.withError(function(){return n(e,t.context)},function(e){t.fail({diff:function(t,n,r,i){return t.inline=!1,t.appendErrorMessage(e)}});})}),t.addAssertion("<UnexpectedError> to [exhaustively] satisfy <function>",function(t,e,n){return t.promise(function(){return e.serializeMessage(t.outputFormat()),n(e)})}),t.addAssertion("<any|Error> to [exhaustively] satisfy <function>",function(t,e,n){return t.promise(function(){return n(e)})}),void 0!==Gt&&t.addAssertion("<Buffer> [when] decoded as <string> <assertion?>",function(t,e,n){return t.shift(e.toString(n))}),t.addAssertion("<any> not to [exhaustively] satisfy [assertion] <any>",function(t,e,n){return t.promise(function(r,i){return t.promise(function(){return t(e,"to [exhaustively] satisfy [assertion]",n)}).then(function(){try{t.fail();}catch(t){i(t);}}).caught(function(t){t&&t._isUnexpected?r():i(t);})})}),t.addAssertion("<any> to [exhaustively] satisfy assertion <any>",function(t,e,n){return t.errorMode="bubble",t(e,"to [exhaustively] satisfy",n)}),t.addAssertion("<any> to [exhaustively] satisfy assertion <assertion>",function(t,e){return t.errorMode="bubble",t.shift()}),t.addAssertion("<any> to [exhaustively] satisfy [assertion] <expect.it>",function(t,e,n){return t.withError(function(){return n(e,t.context)},function(e){t.fail({diff:function(t){return t.inline=!1,t.appendErrorMessage(e)}});})}),t.addAssertion("<regexp> to [exhaustively] satisfy <regexp>",function(t,e,n){t(e,"to equal",n);}),t.addAssertion("<string> to [exhaustively] satisfy <regexp>",function(t,e,n){return t.errorMode="bubble",t(e,"to match",n)}),t.addAssertion("<function> to [exhaustively] satisfy <function>",function(t,e,n){t.errorMode="bubble",t(e,"to equal",n);}),t.addAssertion("<binaryArray> to [exhaustively] satisfy <binaryArray>",function(t,e,n){t.errorMode="bubble",t(e,"to equal",n);}),t.addAssertion("<any> to [exhaustively] satisfy <any>",function(t,e,n){t.errorMode="bubble",t(e,"to equal",n);}),t.addAssertion("<array-like> to [exhaustively] satisfy <array-like>",function(t,e,n){t.errorMode="bubble";var r,i=t.argTypes[0],o=i.getKeys(n),s={};return o.forEach(function(r){s[r]=t.promise(function(){return t.findTypeOf(n[r]).is("function")?n[r](e[r]):t(e[r],"to [exhaustively] satisfy",n[r])});}),t.promise.all([t.promise(function(){t(e,"to only have keys",o);}),t.promise.all(s)]).caught(function(){var o=t.subjectType;return t.promise.settle(s).then(function(){function a(n){t.errorMode="default",t.fail({diff:function(r,i,a,c){r.inline=!0;var f=n.reduce(function(t,e,n){return"insert"===e.type?t:n},-1),l=o.prefix(r.clone(),e);r.append(l).nl(l.isEmpty()?0:1),o.indent&&r.indentLines();var h=dn.packArrows(n);r.arrowsAlongsideChangeOutputs(h,n.map(function(e,n){var i=o.delimiter(r.clone(),n,f+1),c=e.type;return"moveTarget"===c?r.clone():r.clone().block(function(){"moveSource"===c?this.property(e.actualIndex,a(e.value),!0).amend(i.sp()).error("// should be moved"):"insert"===c?this.annotationBlock(function(){var n=void 0!==e.actualIndex?e.actualIndex:e.expectedIndex;t.findTypeOf(e.value).is("function")?this.error("missing: ").property(n,r.clone().block(function(){this.omitSubject=void 0;var t=s[e.expectedIndex];t.isRejected()?this.appendErrorMessage(t.reason()):this.appendInspected(e.value);}),!0):this.error("missing ").property(n,a(e.value),!0);}):this.property(e.actualIndex,r.clone().block(function(){if("remove"===c)this.append(a(e.value).amend(i.sp()).error("// should be removed"));else if("equal"===c)this.append(a(e.value).amend(i));else{var t=u[e.actualIndex][e.expectedIndex],n=t&&!0!==t&&t.getDiff({output:r.clone()});n&&n.inline?this.append(n.amend(i)):this.append(a(e.value).amend(i)).sp().annotationBlock(function(){this.omitSubject=e.value;var r=t.getLabel();r?(this.error(r).sp().block(a(e.expected)),n&&this.nl(2).append(n)):this.appendErrorMessage(t);});}}),!0);})})),o.indent&&r.outdentLines();var p=o.suffix(r.clone(),e);return r.nl(p.isEmpty()?0:1).append(p),r}});}var u=new Array(e.length);for(r=0;r<e.length;r+=1)u[r]=new Array(n.length),r<n.length&&(u[r][r]=s[r].isFulfilled()||s[r].reason());if(e.length>10||n.length>10){var c=[];for(r=0;r<e.length;r+=1){var f=s[r];r<n.length?c.push({type:f.isFulfilled()?"equal":"similar",value:e[r],expected:n[r],actualIndex:r,expectedIndex:r,last:r===Math.max(e.length,n.length)-1}):c.push({type:"remove",value:e[r],actualIndex:r,last:r===e.length-1});}for(r=e.length;r<n.length;r+=1)c.push({type:"insert",value:n[r],expectedIndex:r});return a(c)}var l=!1,h=!o.numericalPropertiesOnly&&dn.uniqueNonNumericalStringsAndSymbols(o.getKeys(e),i.getKeys(n)),p=is(e,n,function(e,n,r,i){u[r]=u[r]||[];var o=u[r][i];if(void 0!==o)return!0===o;var s;try{s=t(e,"to [exhaustively] satisfy",n);}catch(t){return vo(t),u[r][i]=t,!1}return s.then(function(){},function(){}),s.isPending()?(l=!0,!1):(u[r][i]=!0,!0)},function(t,e){return o.similar(t,e)},h);return l?t.promise(function(r,i){vs(e,n,function(e,n,r,i,o){u[r]=u[r]||[];var s=u[r][i];if(void 0!==s)return o(!0===s);t.promise(function(){return t(e,"to [exhaustively] satisfy",n)}).then(function(){u[r][i]=!0,o(!0);},function(t){u[r][i]=t,o(!1);});},function(t,e,n,r,i){i(o.similar(t,e));},h,r);}).then(a):a(p)})})}),t.addAssertion("<object> to [exhaustively] satisfy <object>",function(t,e,n){var r=t.argTypes[0],i=t.subjectType,o=i.is("array-like");if(e!==n){r.is("array-like")&&!o&&t.fail();var s={},a=r.getKeys(n),u=i.getKeys(e);return o||a.forEach(function(t){Object.prototype.hasOwnProperty.call(e,t)&&-1===u.indexOf(t)&&u.push(t);}),a.forEach(function(r,i){s[r]=t.promise(function(){var i=t.findTypeOf(n[r]);return i.is("expect.it")?(t.context.thisObject=e,n[r](e[r],t.context)):i.is("function")?n[r](e[r]):t(e[r],"to [exhaustively] satisfy",n[r])});}),t.promise.all([t.promise(function(){if(t.flags.exhaustively){var r=a.filter(function(t){return!Object.prototype.hasOwnProperty.call(e,t)&&void 0!==e[t]}),i=a.filter(function(t){return void 0!==n[t]}),o=u.filter(function(t){return void 0!==e[t]});t(i.length-r.length,"to equal",o.length);}}),t.promise.all(s)]).caught(function(){return t.promise.settle(s).then(function(){t.fail({diff:function(o,a,c,f){o.inline=!0;var l=i.is("array-like"),h=dn.uniqueStringsAndSymbols(u,r.getKeys(n)).filter(function(t){return t in e||void 0!==n[t]}),p=i.prefix(o.clone(),e);o.append(p).nl(p.isEmpty()?0:1),i.indent&&o.indentLines(),h.forEach(function(r,a){o.nl(a>0?1:0).i().block(function(){var f,p,d=o.clone();Object.prototype.hasOwnProperty.call(s,r)&&s[r].isRejected()&&(p=s[r].reason());var y=i.is("array-like")&&!(r in e),g=!0;if(o.omitSubject=e[r],r in n)if(r in e){if(p||y){var v=p&&p.getDiff({output:o});g=!v||v.inline,y&&o.error("// missing").sp(),v&&v.inline?f=v:"function"==typeof n[r]?(g=!1,d.appendErrorMessage(p)):!v||v&&!v.inline?(d.error(p&&p.getLabel()||"should satisfy").sp().block(c(n[r])),v&&d.nl(2).append(v)):f=v;}}else t.findTypeOf(n[r]).is("function")?s[r].isRejected()?(o.error("// missing:").sp(),f=o.clone().appendErrorMessage(s[r].reason())):(o.error("// missing").sp(),f=o.clone().error("should satisfy").sp().block(c(n[r]))):(o.error("// missing").sp(),f=c(n[r]));else t.flags.exhaustively?d.error("should be removed"):p=null;f||(f=!y&&r in e?c(e[r]):o.clone()),y||a>=u.length-1||f.amend(i.delimiter(o.clone(),a,h.length));var m=!g&&o.preferredWidth<this.size().width+f.size().width+d.size().width;d.isEmpty()||(f.isEmpty()||(m?f.nl():f.sp()),f.annotationBlock(function(){this.append(d);})),g||(f=o.clone().block(f)),this.property(r,f,l);});}),i.indent&&o.outdentLines();var d=i.suffix(o.clone(),e);return o.nl(d.isEmpty()?0:1).append(d)}});})})}}),t.addAssertion("<wrapperObject> to [exhaustively] satisfy <wrapperObject>",function(t,n,r){var i=t.findCommonType(n,r);return t(i.is("wrapperObject"),"to be truthy"),t.withError(function(){return t(i.unwrap(n),"to [exhaustively] satisfy",i.unwrap(r))},function(r){t.fail({label:r.getLabel(),diff:e(r,i,n)});})}),t.addAssertion("<wrapperObject> to [exhaustively] satisfy <any>",function(t,n,r){var i=t.subjectType;return t.withError(function(){return t(i.unwrap(n),"to [exhaustively] satisfy",r)},function(r){t.fail({label:r.getLabel(),diff:e(r,i,n)});})}),t.addAssertion("<function> [when] called with <array-like> <assertion?>",function(t,e,n){t.errorMode="nested",t.argsOutput[0]=function(t){t.appendItems(n,", ");};var r=t.context.thisObject||null;return t.shift(e.apply(r,n))}),t.addAssertion("<function> [when] called <assertion?>",function(t,e){t.errorMode="nested";var n=t.context.thisObject||null;return t.shift(e.call(n))}),t.addAssertion(["<array-like> [when] passed as parameters to [async] <function> <assertion?>","<array-like> [when] passed as parameters to [constructor] <function> <assertion?>"],function(t,e,r){t.errorMode="nested";var i=e;return t.flags.async?t.promise(function(e){(i=[].concat(i)).push(e(function(e,n){return t(e,"to be falsy"),t.shift(n)})),r.apply(null,i);}):t.shift(t.flags.constructor?n(r,i):r.apply(r,i))}),t.addAssertion(["<any> [when] passed as parameter to [async] <function> <assertion?>","<any> [when] passed as parameter to [constructor] <function> <assertion?>"],function(t,e,r){t.errorMode="nested";var i=[e];return t.flags.async?t.promise(function(e){(i=[].concat(i)).push(e(function(e,n){return t(e,"to be falsy"),t.shift(n)})),r.apply(null,i);}):t.shift(t.flags.constructor?n(r,i):r.apply(r,i))}),t.addAssertion(["<array-like> [when] sorted [numerically] <assertion?>","<array-like> [when] sorted by <function> <assertion?>"],function(t,e,n){return t.flags.numerically&&(n=function(t,e){return t-e}),t.shift(Array.prototype.slice.call(e).sort("function"==typeof n?n:void 0))}),t.addAssertion("<Promise> to be rejected",function(t,e){return t.errorMode="nested",t.promise(function(){return e}).then(function(n){t.fail(function(t){t.appendInspected(e).sp().text("unexpectedly fulfilled"),void 0!==n&&t.sp().text("with").sp().appendInspected(n);});},function(t){return t})}),t.addAssertion("<function> to be rejected",function(t,e){return t.errorMode="nested",t(t.promise(function(){return e()}),"to be rejected")}),t.addAssertion(["<Promise> to be rejected with <any>","<Promise> to be rejected with error [exhaustively] satisfying <any>"],function(t,e,n){return t.errorMode="nested",t(e,"to be rejected").tap(function(e){return t.withError(function(){return e&&e._isUnexpected&&("string"==typeof n||_s(n))?t(e,"to have message",n):t(e,"to [exhaustively] satisfy",n)},function(t){throw t.originalError=e,t})})}),t.addAssertion(["<function> to be rejected with <any>","<function> to be rejected with error [exhaustively] satisfying <any>"],function(t,e,n){return t.errorMode="nested",t(t.promise(function(){return e()}),"to be rejected with error [exhaustively] satisfying",n)}),t.addAssertion("<Promise> to be fulfilled",function(t,e){return t.errorMode="nested",t.promise(function(){return e}).caught(function(n){t.fail({output:function(t){t.appendInspected(e).sp().text("unexpectedly rejected"),void 0!==n&&t.sp().text("with").sp().appendInspected(n);},originalError:n});})}),t.addAssertion("<function> to be fulfilled",function(t,e){return t.errorMode="nested",t(t.promise(function(){return e()}),"to be fulfilled")}),t.addAssertion(["<Promise> to be fulfilled with <any>","<Promise> to be fulfilled with value [exhaustively] satisfying <any>"],function(t,e,n){return t.errorMode="nested",t(e,"to be fulfilled").tap(function(e){return t(e,"to [exhaustively] satisfy",n)})}),t.addAssertion(["<function> to be fulfilled with <any>","<function> to be fulfilled with value [exhaustively] satisfying <any>"],function(t,e,n){return t.errorMode="nested",t(t.promise(function(){return e()}),"to be fulfilled with value [exhaustively] satisfying",n)}),t.addAssertion("<Promise> when rejected <assertion>",function(t,e,n){return t.errorMode="nested",t.promise(function(){return e}).then(function(r){"string"==typeof n&&(t.argsOutput=function(e){e.error(n);var r=t.args.slice(1);r.length>0&&e.sp().appendItems(r,", ");}),t.fail(function(t){t.appendInspected(e).sp().text("unexpectedly fulfilled"),void 0!==r&&t.sp().text("with").sp().appendInspected(r);});},function(e){return t.withError(function(){return t.shift(e)},function(t){throw t.originalError=e,t})})}),t.addAssertion("<function> when rejected <assertion>",function(t,e){return t.errorMode="nested",t.apply(t,[t.promise(function(){return e()}),"when rejected"].concat(Array.prototype.slice.call(arguments,2)))}),t.addAssertion("<Promise> when fulfilled <assertion>",function(t,e,n){return t.errorMode="nested",t.promise(function(){return e}).then(function(e){return t.shift(e)},function(r){t.argsOutput=function(e){e.error(n);var r=t.args.slice(1);r.length>0&&e.sp().appendItems(r,", ");},t.fail({output:function(t){t.appendInspected(e).sp().text("unexpectedly rejected"),void 0!==r&&t.sp().text("with").sp().appendInspected(r);},originalError:r});})}),t.addAssertion("<function> when fulfilled <assertion>",function(t,e){return t.errorMode="nested",t.apply(t,[t.promise(function(){return e()}),"when fulfilled"].concat(Array.prototype.slice.call(arguments,2)))}),t.addAssertion("<function> to call the callback",function(t,e){return t.errorMode="nested",t.promise(function(n){var r,i=!1,o=!1,s=n(function(){return o&&t.fail(function(){this.error("The callback was called twice");}),r});if(e(function(){r?o=!0:r=Array.prototype.slice.call(arguments),i&&setTimeout(s,0);}),i=!0,r)return s()})}),t.addAssertion("<function> to call the callback without error",function(t,e){return t(e,"to call the callback").then(function(e){var n=e[0];if(!n)return e.slice(1);t.errorMode="nested",t.fail({message:function(t){t.error("called the callback with: "),n.getErrorMessage?t.appendErrorMessage(n):t.appendInspected(n);}});})}),t.addAssertion("<function> to call the callback with error",function(t,e){return t(e,"to call the callback").spread(function(e){return t(e,"to be truthy"),e})}),t.addAssertion("<function> to call the callback with error <any>",function(t,e,n){return t(e,"to call the callback with error").tap(function(e){return t.errorMode="nested",e&&e._isUnexpected&&("string"==typeof n||_s(n))?t(e,"to have message",n):t(e,"to satisfy",n)})});},xs=t(function(t){t.exports=Ho.create().use(Vo).use(ps).use(Es),co.prototype.inspect=function(){return t.exports.createOutput(Dr.defaultFormat).appendInspected(this).toString()};});return xs});

});

var unexpectedCheck = createCommonjsModule(function (module, exports) {
/*global window*/
// Copyright (c) 2016 Sune Simonsen <sune@we-knowhow.dk>
//
// Permission is hereby granted, free of charge, to any person
// obtaining a copy of this software and associated documentation
// files (the 'Software'), to deal in the Software without
// restriction, including without limitation the rights to use, copy,
// modify, merge, publish, distribute, sublicense, and/or sell copies
// of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS
// BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
// CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

(function (root, factory) {
    {
        module.exports = factory();
    }
})(commonjsGlobal, function () {
    var defaultMaxIterations = 300;
    if (typeof process !== 'undefined' && process.env.UNEXPECTED_CHECK_MAX_ITERATIONS) {
        defaultMaxIterations = parseInt(process.env.UNEXPECTED_CHECK_MAX_ITERATIONS, 10);
    } else if (typeof window !== 'undefined' && typeof window.location !== 'undefined') {
        var m = window.location.search.match(/[?&]maxiterations=(\d+)(?:$|&)/);
        if (m) {
            defaultMaxIterations = parseInt(m[1], 10);
        }
    }

    return {
        name: 'unexpected-check',
        installInto: function (expect) {
            expect.addType({
                name: 'chance-generator',
                identify: function (value) {
                    return value && value.isGenerator;
                },
                inspect: function (value, depth, output) {
                    output.jsFunctionName(value.generatorName);
                    if (value.args.length > 0) {
                        output.text('(').appendItems(value.args, ', ').text(')');
                    }
                }
            });

            expect.addType({
                name: 'mapped-chance-generator',
                identify: function (value) {
                    return value && value.isGenerator && value.isMappedGenerator;
                },
                inspect: function (value, depth, output, inspect) {
                    output.appendInspected(value.parentGenerator)
                      .text('.').jsFunctionName('map').text('(')
                      .appendInspected(value.mapFunction)
                      .text(')');
                }
            });

            expect.addType({
                name: 'fuzzed-generator',
                identify: function (value) {
                    return value && value.isFuzzedGenerator;
                },
                inspect: function (value, depth, output, inspect) {
                    output.jsFunctionName('fuzz')
                      .text('(')
                      .appendItems(value.args, ', ')
                      .text(', ')
                      .appendInspected(value.mutatorFunction)
                      .text(')');
                }
            });

            var promiseLoop = function (condition, action) {
                return expect.promise(function (resolve, reject) {
                    var loop = function () {
                        if (!condition()) {
                            return resolve();
                        }

                        return action()
                            .then(loop)
                            .catch(reject);
                    };

                    loop();
                });
            };

            expect.addAssertion('<function> to be valid for all <object>', function (expect, subject, options) {
                var generators = options.generators || [];
                var maxIterations = options.maxIterations || defaultMaxIterations;
                var maxErrorIterations = options.maxErrorIterations || 1000;
                var maxErrors = options.maxErrors || 50;

                function createTask() {
                    var args = generators.map(function (g) {
                        return g();
                    });

                    var task = {
                        args: args
                    };

                    return task;
                }

                function hasShrinkableGenerators() {
                    return generators.some(function (g) {
                        return g.shrink;
                    });
                }

                function createTasks() {
                    var tasks = [];
                    var errors = 0;
                    var i = 0;

                    return promiseLoop(function () {
                        return (
                            (
                                errors === 0
                                  ? i < maxIterations
                                  : i < maxErrorIterations
                            ) &&
                            errors < maxErrors &&
                            (errors === 0 || hasShrinkableGenerators())
                        );
                    }, function () {
                        var task = createTask();
                        tasks.push(task);

                        return expect.promise(function () {
                            return subject.apply(null, task.args);
                        }).then(function () {
                            i++;
                        }, function (err) {
                            generators = generators.map(function (g, i) {
                                return g.shrink ? g.shrink(task.args[i]) : g;
                            });
                            task.error = err;
                            errors++;
                            i++;
                        });
                    }).then(function () {
                        return tasks;
                    });
                }

                return createTasks().then(function (tasks) {
                    var failedTasks = tasks.filter(function (task) {
                        return task.error;
                    });

                    if (failedTasks.length > 0) {
                        var bestFailure = failedTasks[failedTasks.length - 1];

                        expect.errorMode = 'bubble';
                        expect.fail(function (output) {
                            output.error('Ran ').jsNumber(tasks.length).sp()
                                .error(tasks.length > 1 ? 'iterations' : 'iteration')
                                .error(' and found ').jsNumber(failedTasks.length).error(' errors').nl()
                                .error('counterexample:').nl(2);

                            output.indentLines();
                            output.i().block(function (output) {
                                output.text('Generated input: ').appendItems(bestFailure.args, ', ').nl()
                                  .text('with: ').appendItems(options.generators, ', ').nl(2)
                                  .block(function (output) {
                                      output.appendErrorMessage(bestFailure.error);
                                  });
                            });
                        });
                    }
                });
            });

            expect.addAssertion('<function> to be valid for all <function+>', function (expect, subject) {
                expect.errorMode = 'bubble';

                return expect(subject, 'to be valid for all', {
                    generators: Array.prototype.slice.call(arguments, 2)
                });
            });

            function fuzzedGenerator(input, mutator, mutationGenerator) {
                mutationGenerator = mutationGenerator || mutator(input);
                var generator = function () {
                    return mutationGenerator();
                };

                if (mutationGenerator.shrink) {
                    generator.shrink = function (value) {
                        return fuzzedGenerator(input, mutator, mutationGenerator.shrink(value));
                    };
                }

                generator.isGenerator = true;
                generator.isFuzzedGenerator = true;
                generator.args = [input];
                generator.mutatorFunction = mutator;

                return generator;
            }

            expect.addAssertion('<any> [when] fuzzed by <function> <assertion>', function (expect, subject, mutator) {
                expect.errorMode = 'bubble';

                return expect(function (value) {
                    return expect.shift(value);
                }, 'to be valid for all', fuzzedGenerator(subject, mutator));
            });
        }
    };
});
});

var chance_1 = createCommonjsModule(function (module, exports) {
//  Chance.js 1.0.1
//  http://chancejs.com
//  (c) 2013 Victor Quinn
//  Chance may be freely distributed or modified under the MIT license.

(function () {

    // Constants
    var MAX_INT = 9007199254740992;
    var MIN_INT = -MAX_INT;
    var NUMBERS = '0123456789';
    var CHARS_LOWER = 'abcdefghijklmnopqrstuvwxyz';
    var CHARS_UPPER = CHARS_LOWER.toUpperCase();
    var HEX_POOL  = NUMBERS + "abcdef";

    // Cached array helpers
    var slice = Array.prototype.slice;

    // Constructor
    function Chance (seed) {
        if (!(this instanceof Chance)) {
            return seed == null ? new Chance() : new Chance(seed);
        }

        // if user has provided a function, use that as the generator
        if (typeof seed === 'function') {
            this.random = seed;
            return this;
        }

        if (arguments.length) {
            // set a starting value of zero so we can add to it
            this.seed = 0;
        }

        // otherwise, leave this.seed blank so that MT will receive a blank

        for (var i = 0; i < arguments.length; i++) {
            var seedling = 0;
            if (Object.prototype.toString.call(arguments[i]) === '[object String]') {
                for (var j = 0; j < arguments[i].length; j++) {
                    // create a numeric hash for each argument, add to seedling
                    var hash = 0;
                    for (var k = 0; k < arguments[i].length; k++) {
                        hash = arguments[i].charCodeAt(k) + (hash << 6) + (hash << 16) - hash;
                    }
                    seedling += hash;
                }
            } else {
                seedling = arguments[i];
            }
            this.seed += (arguments.length - i) * seedling;
        }

        // If no generator function was provided, use our MT
        this.mt = this.mersenne_twister(this.seed);
        this.bimd5 = this.blueimp_md5();
        this.random = function () {
            return this.mt.random(this.seed);
        };

        return this;
    }

    Chance.prototype.VERSION = "1.0.1";

    // Random helper functions
    function initOptions(options, defaults) {
        options || (options = {});

        if (defaults) {
            for (var i in defaults) {
                if (typeof options[i] === 'undefined') {
                    options[i] = defaults[i];
                }
            }
        }

        return options;
    }

    function testRange(test, errorMessage) {
        if (test) {
            throw new RangeError(errorMessage);
        }
    }

    /**
     * Encode the input string with Base64.
     */
    var base64 = function() {
        throw new Error('No Base64 encoder available.');
    };

    // Select proper Base64 encoder.
    (function determineBase64Encoder() {
        if (typeof btoa === 'function') {
            base64 = btoa;
        } else if (typeof Buffer === 'function') {
            base64 = function(input) {
                return new Buffer(input).toString('base64');
            };
        }
    })();

    // -- Basics --

    /**
     *  Return a random bool, either true or false
     *
     *  @param {Object} [options={ likelihood: 50 }] alter the likelihood of
     *    receiving a true or false value back.
     *  @throws {RangeError} if the likelihood is out of bounds
     *  @returns {Bool} either true or false
     */
    Chance.prototype.bool = function (options) {
        // likelihood of success (true)
        options = initOptions(options, {likelihood : 50});

        // Note, we could get some minor perf optimizations by checking range
        // prior to initializing defaults, but that makes code a bit messier
        // and the check more complicated as we have to check existence of
        // the object then existence of the key before checking constraints.
        // Since the options initialization should be minor computationally,
        // decision made for code cleanliness intentionally. This is mentioned
        // here as it's the first occurrence, will not be mentioned again.
        testRange(
            options.likelihood < 0 || options.likelihood > 100,
            "Chance: Likelihood accepts values from 0 to 100."
        );

        return this.random() * 100 < options.likelihood;
    };

    /**
     *  Return a random character.
     *
     *  @param {Object} [options={}] can specify a character pool, only alpha,
     *    only symbols, and casing (lower or upper)
     *  @returns {String} a single random character
     *  @throws {RangeError} Can only specify alpha or symbols, not both
     */
    Chance.prototype.character = function (options) {
        options = initOptions(options);
        testRange(
            options.alpha && options.symbols,
            "Chance: Cannot specify both alpha and symbols."
        );

        var symbols = "!@#$%^&*()[]",
            letters, pool;

        if (options.casing === 'lower') {
            letters = CHARS_LOWER;
        } else if (options.casing === 'upper') {
            letters = CHARS_UPPER;
        } else {
            letters = CHARS_LOWER + CHARS_UPPER;
        }

        if (options.pool) {
            pool = options.pool;
        } else if (options.alpha) {
            pool = letters;
        } else if (options.symbols) {
            pool = symbols;
        } else {
            pool = letters + NUMBERS + symbols;
        }

        return pool.charAt(this.natural({max: (pool.length - 1)}));
    };

    // Note, wanted to use "float" or "double" but those are both JS reserved words.

    // Note, fixed means N OR LESS digits after the decimal. This because
    // It could be 14.9000 but in JavaScript, when this is cast as a number,
    // the trailing zeroes are dropped. Left to the consumer if trailing zeroes are
    // needed
    /**
     *  Return a random floating point number
     *
     *  @param {Object} [options={}] can specify a fixed precision, min, max
     *  @returns {Number} a single floating point number
     *  @throws {RangeError} Can only specify fixed or precision, not both. Also
     *    min cannot be greater than max
     */
    Chance.prototype.floating = function (options) {
        options = initOptions(options, {fixed : 4});
        testRange(
            options.fixed && options.precision,
            "Chance: Cannot specify both fixed and precision."
        );

        var num;
        var fixed = Math.pow(10, options.fixed);

        var max = MAX_INT / fixed;
        var min = -max;

        testRange(
            options.min && options.fixed && options.min < min,
            "Chance: Min specified is out of range with fixed. Min should be, at least, " + min
        );
        testRange(
            options.max && options.fixed && options.max > max,
            "Chance: Max specified is out of range with fixed. Max should be, at most, " + max
        );

        options = initOptions(options, { min : min, max : max });

        // Todo - Make this work!
        // options.precision = (typeof options.precision !== "undefined") ? options.precision : false;

        num = this.integer({min: options.min * fixed, max: options.max * fixed});
        var num_fixed = (num / fixed).toFixed(options.fixed);

        return parseFloat(num_fixed);
    };

    /**
     *  Return a random integer
     *
     *  NOTE the max and min are INCLUDED in the range. So:
     *  chance.integer({min: 1, max: 3});
     *  would return either 1, 2, or 3.
     *
     *  @param {Object} [options={}] can specify a min and/or max
     *  @returns {Number} a single random integer number
     *  @throws {RangeError} min cannot be greater than max
     */
    Chance.prototype.integer = function (options) {
        // 9007199254740992 (2^53) is the max integer number in JavaScript
        // See: http://vq.io/132sa2j
        options = initOptions(options, {min: MIN_INT, max: MAX_INT});
        testRange(options.min > options.max, "Chance: Min cannot be greater than Max.");

        return Math.floor(this.random() * (options.max - options.min + 1) + options.min);
    };

    /**
     *  Return a random natural
     *
     *  NOTE the max and min are INCLUDED in the range. So:
     *  chance.natural({min: 1, max: 3});
     *  would return either 1, 2, or 3.
     *
     *  @param {Object} [options={}] can specify a min and/or max
     *  @returns {Number} a single random integer number
     *  @throws {RangeError} min cannot be greater than max
     */
    Chance.prototype.natural = function (options) {
        options = initOptions(options, {min: 0, max: MAX_INT});
        testRange(options.min < 0, "Chance: Min cannot be less than zero.");
        return this.integer(options);
    };

    /**
     *  Return a random string
     *
     *  @param {Object} [options={}] can specify a length
     *  @returns {String} a string of random length
     *  @throws {RangeError} length cannot be less than zero
     */
    Chance.prototype.string = function (options) {
        options = initOptions(options, { length: this.natural({min: 5, max: 20}) });
        testRange(options.length < 0, "Chance: Length cannot be less than zero.");
        var length = options.length,
            text = this.n(this.character, length, options);

        return text.join("");
    };

    // -- End Basics --

    // -- Helpers --

    Chance.prototype.capitalize = function (word) {
        return word.charAt(0).toUpperCase() + word.substr(1);
    };

    Chance.prototype.mixin = function (obj) {
        for (var func_name in obj) {
            Chance.prototype[func_name] = obj[func_name];
        }
        return this;
    };

    /**
     *  Given a function that generates something random and a number of items to generate,
     *    return an array of items where none repeat.
     *
     *  @param {Function} fn the function that generates something random
     *  @param {Number} num number of terms to generate
     *  @param {Object} options any options to pass on to the generator function
     *  @returns {Array} an array of length `num` with every item generated by `fn` and unique
     *
     *  There can be more parameters after these. All additional parameters are provided to the given function
     */
    Chance.prototype.unique = function(fn, num, options) {
        testRange(
            typeof fn !== "function",
            "Chance: The first argument must be a function."
        );

        options = initOptions(options, {
            // Default comparator to check that val is not already in arr.
            // Should return `false` if item not in array, `true` otherwise
            comparator: function(arr, val) {
                return arr.indexOf(val) !== -1;
            }
        });

        var arr = [], count = 0, result, MAX_DUPLICATES = num * 50, params = slice.call(arguments, 2);

        while (arr.length < num) {
            result = fn.apply(this, params);
            if (!options.comparator(arr, result)) {
                arr.push(result);
                // reset count when unique found
                count = 0;
            }

            if (++count > MAX_DUPLICATES) {
                throw new RangeError("Chance: num is likely too large for sample set");
            }
        }
        return arr;
    };

    /**
     *  Gives an array of n random terms
     *
     *  @param {Function} fn the function that generates something random
     *  @param {Number} n number of terms to generate
     *  @returns {Array} an array of length `n` with items generated by `fn`
     *
     *  There can be more parameters after these. All additional parameters are provided to the given function
     */
    Chance.prototype.n = function(fn, n) {
        testRange(
            typeof fn !== "function",
            "Chance: The first argument must be a function."
        );

        if (typeof n === 'undefined') {
            n = 1;
        }
        var i = n, arr = [], params = slice.call(arguments, 2);

        // Providing a negative count should result in a noop.
        i = Math.max( 0, i );

        for (null; i--; null) {
            arr.push(fn.apply(this, params));
        }

        return arr;
    };

    // H/T to SO for this one: http://vq.io/OtUrZ5
    Chance.prototype.pad = function (number, width, pad) {
        // Default pad to 0 if none provided
        pad = pad || '0';
        // Convert number to a string
        number = number + '';
        return number.length >= width ? number : new Array(width - number.length + 1).join(pad) + number;
    };

    // DEPRECATED on 2015-10-01
    Chance.prototype.pick = function (arr, count) {
        if (arr.length === 0) {
            throw new RangeError("Chance: Cannot pick() from an empty array");
        }
        if (!count || count === 1) {
            return arr[this.natural({max: arr.length - 1})];
        } else {
            return this.shuffle(arr).slice(0, count);
        }
    };

    // Given an array, returns a single random element
    Chance.prototype.pickone = function (arr) {
        if (arr.length === 0) {
          throw new RangeError("Chance: Cannot pickone() from an empty array");
        }
        return arr[this.natural({max: arr.length - 1})];
    };

    // Given an array, returns a random set with 'count' elements
    Chance.prototype.pickset = function (arr, count) {
        if (count === 0) {
            return [];
        }
        if (arr.length === 0) {
            throw new RangeError("Chance: Cannot pickset() from an empty array");
        }
        if (count < 0) {
            throw new RangeError("Chance: count must be positive number");
        }
        if (!count || count === 1) {
            return [ this.pickone(arr) ];
        } else {
            return this.shuffle(arr).slice(0, count);
        }
    };

    Chance.prototype.shuffle = function (arr) {
        var old_array = arr.slice(0),
            new_array = [],
            j = 0,
            length = Number(old_array.length);

        for (var i = 0; i < length; i++) {
            // Pick a random index from the array
            j = this.natural({max: old_array.length - 1});
            // Add it to the new array
            new_array[i] = old_array[j];
            // Remove that element from the original array
            old_array.splice(j, 1);
        }

        return new_array;
    };

    // Returns a single item from an array with relative weighting of odds
    Chance.prototype.weighted = function(arr, weights) {
        if (arr.length !== weights.length) {
            throw new RangeError("Chance: length of array and weights must match");
        }

        // Handle weights that are less or equal to zero.
        for (var weightIndex = weights.length - 1; weightIndex >= 0; --weightIndex) {
            // If the weight is less or equal to zero, remove it and the value.
            if (weights[weightIndex] <= 0) {
                arr.splice(weightIndex,1);
                weights.splice(weightIndex,1);
            }
        }

        // If any of the weights are less than 1, we want to scale them up to whole
        //   numbers for the rest of this logic to work
        if (weights.some(function(weight) { return weight < 1; })) {
            var min = weights.reduce(function(min, weight) {
                return (weight < min) ? weight : min;
            }, weights[0]);

            var scaling_factor = 1 / min;

            weights = weights.map(function(weight) {
                return weight * scaling_factor;
            });
        }

        var sum = weights.reduce(function(total, weight) {
            return total + weight;
        }, 0);

        // get an index
        var selected = this.natural({ min: 1, max: sum });

        var total = 0;
        var chosen;
        // Using some() here so we can bail as soon as we get our match
        weights.some(function(weight, index) {
            if (selected <= total + weight) {
                chosen = arr[index];
                return true;
            }
            total += weight;
            return false;
        });

        return chosen;
    };

    // -- End Helpers --

    // -- Text --

    Chance.prototype.paragraph = function (options) {
        options = initOptions(options);

        var sentences = options.sentences || this.natural({min: 3, max: 7}),
            sentence_array = this.n(this.sentence, sentences);

        return sentence_array.join(' ');
    };

    // Could get smarter about this than generating random words and
    // chaining them together. Such as: http://vq.io/1a5ceOh
    Chance.prototype.sentence = function (options) {
        options = initOptions(options);

        var words = options.words || this.natural({min: 12, max: 18}),
            punctuation = options.punctuation,
            text, word_array = this.n(this.word, words);

        text = word_array.join(' ');
        
        // Capitalize first letter of sentence
        text = this.capitalize(text);
        
        // Make sure punctuation has a usable value
        if (punctuation !== false && !/^[\.\?;!:]$/.test(punctuation)) {
            punctuation = '.';
        }
        
        // Add punctuation mark
        if (punctuation) {
            text += punctuation;
        }

        return text;
    };

    Chance.prototype.syllable = function (options) {
        options = initOptions(options);

        var length = options.length || this.natural({min: 2, max: 3}),
            consonants = 'bcdfghjklmnprstvwz', // consonants except hard to speak ones
            vowels = 'aeiou', // vowels
            all = consonants + vowels, // all
            text = '',
            chr;

        // I'm sure there's a more elegant way to do this, but this works
        // decently well.
        for (var i = 0; i < length; i++) {
            if (i === 0) {
                // First character can be anything
                chr = this.character({pool: all});
            } else if (consonants.indexOf(chr) === -1) {
                // Last character was a vowel, now we want a consonant
                chr = this.character({pool: consonants});
            } else {
                // Last character was a consonant, now we want a vowel
                chr = this.character({pool: vowels});
            }

            text += chr;
        }

        if (options.capitalize) {
            text = this.capitalize(text);
        }

        return text;
    };

    Chance.prototype.word = function (options) {
        options = initOptions(options);

        testRange(
            options.syllables && options.length,
            "Chance: Cannot specify both syllables AND length."
        );

        var syllables = options.syllables || this.natural({min: 1, max: 3}),
            text = '';

        if (options.length) {
            // Either bound word by length
            do {
                text += this.syllable();
            } while (text.length < options.length);
            text = text.substring(0, options.length);
        } else {
            // Or by number of syllables
            for (var i = 0; i < syllables; i++) {
                text += this.syllable();
            }
        }

        if (options.capitalize) {
            text = this.capitalize(text);
        }

        return text;
    };

    // -- End Text --

    // -- Person --

    Chance.prototype.age = function (options) {
        options = initOptions(options);
        var ageRange;

        switch (options.type) {
            case 'child':
                ageRange = {min: 1, max: 12};
                break;
            case 'teen':
                ageRange = {min: 13, max: 19};
                break;
            case 'adult':
                ageRange = {min: 18, max: 65};
                break;
            case 'senior':
                ageRange = {min: 65, max: 100};
                break;
            case 'all':
                ageRange = {min: 1, max: 100};
                break;
            default:
                ageRange = {min: 18, max: 65};
                break;
        }

        return this.natural(ageRange);
    };

    Chance.prototype.birthday = function (options) {
        options = initOptions(options, {
            year: (new Date().getFullYear() - this.age(options))
        });

        return this.date(options);
    };

    // CPF; ID to identify taxpayers in Brazil
    Chance.prototype.cpf = function () {
        var n = this.n(this.natural, 9, { max: 9 });
        var d1 = n[8]*2+n[7]*3+n[6]*4+n[5]*5+n[4]*6+n[3]*7+n[2]*8+n[1]*9+n[0]*10;
        d1 = 11 - (d1 % 11);
        if (d1>=10) {
            d1 = 0;
        }
        var d2 = d1*2+n[8]*3+n[7]*4+n[6]*5+n[5]*6+n[4]*7+n[3]*8+n[2]*9+n[1]*10+n[0]*11;
        d2 = 11 - (d2 % 11);
        if (d2>=10) {
            d2 = 0;
        }
        return ''+n[0]+n[1]+n[2]+'.'+n[3]+n[4]+n[5]+'.'+n[6]+n[7]+n[8]+'-'+d1+d2;
    };

    Chance.prototype.first = function (options) {
        options = initOptions(options, {gender: this.gender(), nationality: 'en'});
        return this.pick(this.get("firstNames")[options.gender.toLowerCase()][options.nationality.toLowerCase()]);
    };

    Chance.prototype.gender = function () {
        return this.pick(['Male', 'Female']);
    };

    Chance.prototype.last = function (options) {
        options = initOptions(options, {nationality: 'en'});
        return this.pick(this.get("lastNames")[options.nationality.toLowerCase()]);
    };
    
    Chance.prototype.israelId=function(){
        var x=this.string({pool: '0123456789',length:8});
        var y=0;
        for (var i=0;i<x.length;i++){
            var thisDigit=  x[i] *  (i/2===parseInt(i/2) ? 1 : 2);
            thisDigit=this.pad(thisDigit,2).toString();
            thisDigit=parseInt(thisDigit[0]) + parseInt(thisDigit[1]);
            y=y+thisDigit;
        }
        x=x+(10-parseInt(y.toString().slice(-1))).toString().slice(-1);
        return x;
    };

    Chance.prototype.mrz = function (options) {
        var checkDigit = function (input) {
            var alpha = "<ABCDEFGHIJKLMNOPQRSTUVWXYXZ".split(''),
                multipliers = [ 7, 3, 1 ],
                runningTotal = 0;

            if (typeof input !== 'string') {
                input = input.toString();
            }

            input.split('').forEach(function(character, idx) {
                var pos = alpha.indexOf(character);

                if(pos !== -1) {
                    character = pos === 0 ? 0 : pos + 9;
                } else {
                    character = parseInt(character, 10);
                }
                character *= multipliers[idx % multipliers.length];
                runningTotal += character;
            });
            return runningTotal % 10;
        };
        var generate = function (opts) {
            var pad = function (length) {
                return new Array(length + 1).join('<');
            };
            var number = [ 'P<',
                           opts.issuer,
                           opts.last.toUpperCase(),
                           '<<',
                           opts.first.toUpperCase(),
                           pad(39 - (opts.last.length + opts.first.length + 2)),
                           opts.passportNumber,
                           checkDigit(opts.passportNumber),
                           opts.nationality,
                           opts.dob,
                           checkDigit(opts.dob),
                           opts.gender,
                           opts.expiry,
                           checkDigit(opts.expiry),
                           pad(14),
                           checkDigit(pad(14)) ].join('');

            return number +
                (checkDigit(number.substr(44, 10) +
                            number.substr(57, 7) +
                            number.substr(65, 7)));
        };

        var that = this;

        options = initOptions(options, {
            first: this.first(),
            last: this.last(),
            passportNumber: this.integer({min: 100000000, max: 999999999}),
            dob: (function () {
                var date = that.birthday({type: 'adult'});
                return [date.getFullYear().toString().substr(2),
                        that.pad(date.getMonth() + 1, 2),
                        that.pad(date.getDate(), 2)].join('');
            }()),
            expiry: (function () {
                var date = new Date();
                return [(date.getFullYear() + 5).toString().substr(2),
                        that.pad(date.getMonth() + 1, 2),
                        that.pad(date.getDate(), 2)].join('');
            }()),
            gender: this.gender() === 'Female' ? 'F': 'M',
            issuer: 'GBR',
            nationality: 'GBR'
        });
        return generate (options);
    };

    Chance.prototype.name = function (options) {
        options = initOptions(options);

        var first = this.first(options),
            last = this.last(options),
            name;

        if (options.middle) {
            name = first + ' ' + this.first(options) + ' ' + last;
        } else if (options.middle_initial) {
            name = first + ' ' + this.character({alpha: true, casing: 'upper'}) + '. ' + last;
        } else {
            name = first + ' ' + last;
        }

        if (options.prefix) {
            name = this.prefix(options) + ' ' + name;
        }

        if (options.suffix) {
            name = name + ' ' + this.suffix(options);
        }

        return name;
    };

    // Return the list of available name prefixes based on supplied gender.
    // @todo introduce internationalization
    Chance.prototype.name_prefixes = function (gender) {
        gender = gender || "all";
        gender = gender.toLowerCase();

        var prefixes = [
            { name: 'Doctor', abbreviation: 'Dr.' }
        ];

        if (gender === "male" || gender === "all") {
            prefixes.push({ name: 'Mister', abbreviation: 'Mr.' });
        }

        if (gender === "female" || gender === "all") {
            prefixes.push({ name: 'Miss', abbreviation: 'Miss' });
            prefixes.push({ name: 'Misses', abbreviation: 'Mrs.' });
        }

        return prefixes;
    };

    // Alias for name_prefix
    Chance.prototype.prefix = function (options) {
        return this.name_prefix(options);
    };

    Chance.prototype.name_prefix = function (options) {
        options = initOptions(options, { gender: "all" });
        return options.full ?
            this.pick(this.name_prefixes(options.gender)).name :
            this.pick(this.name_prefixes(options.gender)).abbreviation;
    };

    Chance.prototype.ssn = function (options) {
        options = initOptions(options, {ssnFour: false, dashes: true});
        var ssn_pool = "1234567890",
            ssn,
            dash = options.dashes ? '-' : '';

        if(!options.ssnFour) {
            ssn = this.string({pool: ssn_pool, length: 3}) + dash +
            this.string({pool: ssn_pool, length: 2}) + dash +
            this.string({pool: ssn_pool, length: 4});
        } else {
            ssn = this.string({pool: ssn_pool, length: 4});
        }
        return ssn;
    };

    // Return the list of available name suffixes
    // @todo introduce internationalization
    Chance.prototype.name_suffixes = function () {
        var suffixes = [
            { name: 'Doctor of Osteopathic Medicine', abbreviation: 'D.O.' },
            { name: 'Doctor of Philosophy', abbreviation: 'Ph.D.' },
            { name: 'Esquire', abbreviation: 'Esq.' },
            { name: 'Junior', abbreviation: 'Jr.' },
            { name: 'Juris Doctor', abbreviation: 'J.D.' },
            { name: 'Master of Arts', abbreviation: 'M.A.' },
            { name: 'Master of Business Administration', abbreviation: 'M.B.A.' },
            { name: 'Master of Science', abbreviation: 'M.S.' },
            { name: 'Medical Doctor', abbreviation: 'M.D.' },
            { name: 'Senior', abbreviation: 'Sr.' },
            { name: 'The Third', abbreviation: 'III' },
            { name: 'The Fourth', abbreviation: 'IV' },
            { name: 'Bachelor of Engineering', abbreviation: 'B.E' },
            { name: 'Bachelor of Technology', abbreviation: 'B.TECH' }
        ];
        return suffixes;
    };

    // Alias for name_suffix
    Chance.prototype.suffix = function (options) {
        return this.name_suffix(options);
    };

    Chance.prototype.name_suffix = function (options) {
        options = initOptions(options);
        return options.full ?
            this.pick(this.name_suffixes()).name :
            this.pick(this.name_suffixes()).abbreviation;
    };

    Chance.prototype.nationalities = function () {
        return this.get("nationalities");
    };

    // Generate random nationality based on json list
    Chance.prototype.nationality = function () {
        var nationality = this.pick(this.nationalities());
        return nationality.name;
    };

    // -- End Person --

    // -- Mobile --
    // Android GCM Registration ID
    Chance.prototype.android_id = function () {
        return "APA91" + this.string({ pool: "0123456789abcefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_", length: 178 });
    };

    // Apple Push Token
    Chance.prototype.apple_token = function () {
        return this.string({ pool: "abcdef1234567890", length: 64 });
    };

    // Windows Phone 8 ANID2
    Chance.prototype.wp8_anid2 = function () {
        return base64( this.hash( { length : 32 } ) );
    };

    // Windows Phone 7 ANID
    Chance.prototype.wp7_anid = function () {
        return 'A=' + this.guid().replace(/-/g, '').toUpperCase() + '&E=' + this.hash({ length:3 }) + '&W=' + this.integer({ min:0, max:9 });
    };

    // BlackBerry Device PIN
    Chance.prototype.bb_pin = function () {
        return this.hash({ length: 8 });
    };

    // -- End Mobile --

    // -- Web --
    Chance.prototype.avatar = function (options) {
        var url = null;
        var URL_BASE = '//www.gravatar.com/avatar/';
        var PROTOCOLS = {
            http: 'http',
            https: 'https'
        };
        var FILE_TYPES = {
            bmp: 'bmp',
            gif: 'gif',
            jpg: 'jpg',
            png: 'png'
        };
        var FALLBACKS = {
            '404': '404', // Return 404 if not found
            mm: 'mm', // Mystery man
            identicon: 'identicon', // Geometric pattern based on hash
            monsterid: 'monsterid', // A generated monster icon
            wavatar: 'wavatar', // A generated face
            retro: 'retro', // 8-bit icon
            blank: 'blank' // A transparent png
        };
        var RATINGS = {
            g: 'g',
            pg: 'pg',
            r: 'r',
            x: 'x'
        };
        var opts = {
            protocol: null,
            email: null,
            fileExtension: null,
            size: null,
            fallback: null,
            rating: null
        };

        if (!options) {
            // Set to a random email
            opts.email = this.email();
            options = {};
        }
        else if (typeof options === 'string') {
            opts.email = options;
            options = {};
        }
        else if (typeof options !== 'object') {
            return null;
        }
        else if (options.constructor === 'Array') {
            return null;
        }

        opts = initOptions(options, opts);

        if (!opts.email) {
            // Set to a random email
            opts.email = this.email();
        }

        // Safe checking for params
        opts.protocol = PROTOCOLS[opts.protocol] ? opts.protocol + ':' : '';
        opts.size = parseInt(opts.size, 0) ? opts.size : '';
        opts.rating = RATINGS[opts.rating] ? opts.rating : '';
        opts.fallback = FALLBACKS[opts.fallback] ? opts.fallback : '';
        opts.fileExtension = FILE_TYPES[opts.fileExtension] ? opts.fileExtension : '';

        url =
            opts.protocol +
            URL_BASE +
            this.bimd5.md5(opts.email) +
            (opts.fileExtension ? '.' + opts.fileExtension : '') +
            (opts.size || opts.rating || opts.fallback ? '?' : '') +
            (opts.size ? '&s=' + opts.size.toString() : '') +
            (opts.rating ? '&r=' + opts.rating : '') +
            (opts.fallback ? '&d=' + opts.fallback : '')
            ;

        return url;
    };

    /**
     * #Description:
     * ===============================================
     * Generate random color value base on color type:
     * -> hex
     * -> rgb
     * -> rgba
     * -> 0x
     * -> named color
     *
     * #Examples: 
     * ===============================================
     * * Geerate random hex color
     * chance.color() => '#79c157' / 'rgb(110,52,164)' / '0x67ae0b' / '#e2e2e2' / '#29CFA7'
     * 
     * * Generate Hex based color value
     * chance.color({format: 'hex'})    => '#d67118'
     *
     * * Generate simple rgb value
     * chance.color({format: 'rgb'})    => 'rgb(110,52,164)'
     *
     * * Generate Ox based color value
     * chance.color({format: '0x'})     => '0x67ae0b' 
     *
     * * Generate graiscale based value
     * chance.color({grayscale: true})  => '#e2e2e2'
     *
     * * Return valide color name
     * chance.color({format: 'name'})   => 'red'
     * 
     * * Make color uppercase
     * chance.color({casing: 'upper'})  => '#29CFA7'
     *
     * @param  [object] options
     * @return [string] color value
     */
    Chance.prototype.color = function (options) {

        function gray(value, delimiter) {
            return [value, value, value].join(delimiter || '');
        }

        function rgb(hasAlpha) {

            var rgbValue    = (hasAlpha)    ? 'rgba' : 'rgb'; 
            var alphaChanal = (hasAlpha)    ? (',' + this.floating({min:0, max:1})) : "";
            var colorValue  = (isGrayscale) ? (gray(this.natural({max: 255}), ',')) : (this.natural({max: 255}) + ',' + this.natural({max: 255}) + ',' + this.natural({max: 255}));

            return rgbValue + '(' + colorValue + alphaChanal + ')';
        }

        function hex(start, end, withHash) {

            var simbol = (withHash) ? "#" : "";
            var expression  = (isGrayscale ? gray(this.hash({length: start})) : this.hash({length: end})); 
            return simbol + expression;
        }

        options = initOptions(options, {
            format: this.pick(['hex', 'shorthex', 'rgb', 'rgba', '0x', 'name']),
            grayscale: false,
            casing: 'lower'
        });

        var isGrayscale = options.grayscale;
        var colorValue;

        if (options.format === 'hex') {
            colorValue =  hex.call(this, 2, 6, true);
        }
        else if (options.format === 'shorthex') {
            colorValue = hex.call(this, 1, 3, true);
        } 
        else if (options.format === 'rgb') {
            colorValue = rgb.call(this, false);
        } 
        else if (options.format === 'rgba') {
            colorValue = rgb.call(this, true);
        } 
        else if (options.format === '0x') {
            colorValue = '0x' + hex.call(this, 2, 6);
        } 
        else if(options.format === 'name') {
            return this.pick(this.get("colorNames"));
        }
        else {
            throw new RangeError('Invalid format provided. Please provide one of "hex", "shorthex", "rgb", "rgba", "0x" or "name".');
        }

        if (options.casing === 'upper' ) {
            colorValue = colorValue.toUpperCase();
        }

        return colorValue;
    };

    Chance.prototype.domain = function (options) {
        options = initOptions(options);
        return this.word() + '.' + (options.tld || this.tld());
    };

    Chance.prototype.email = function (options) {
        options = initOptions(options);
        return this.word({length: options.length}) + '@' + (options.domain || this.domain());
    };

    Chance.prototype.fbid = function () {
        return parseInt('10000' + this.natural({max: 100000000000}), 10);
    };

    Chance.prototype.google_analytics = function () {
        var account = this.pad(this.natural({max: 999999}), 6);
        var property = this.pad(this.natural({max: 99}), 2);

        return 'UA-' + account + '-' + property;
    };

    Chance.prototype.hashtag = function () {
        return '#' + this.word();
    };

    Chance.prototype.ip = function () {
        // Todo: This could return some reserved IPs. See http://vq.io/137dgYy
        // this should probably be updated to account for that rare as it may be
        return this.natural({max: 255}) + '.' +
               this.natural({max: 255}) + '.' +
               this.natural({max: 255}) + '.' +
               this.natural({max: 255});
    };

    Chance.prototype.ipv6 = function () {
        var ip_addr = this.n(this.hash, 8, {length: 4});

        return ip_addr.join(":");
    };

    Chance.prototype.klout = function () {
        return this.natural({min: 1, max: 99});
    };

    Chance.prototype.semver = function (options) {
        options = initOptions(options, { include_prerelease: true });

        var range = this.pickone(["^", "~", "<", ">", "<=", ">=", "="]);
        if (options.range) {
            range = options.range;
        }

        var prerelease = "";
        if (options.include_prerelease) {
            prerelease = this.weighted(["", "-dev", "-beta", "-alpha"], [50, 10, 5, 1]);
        }
        return range + this.rpg('3d10').join('.') + prerelease;
    };

    Chance.prototype.tlds = function () {
        return ['com', 'org', 'edu', 'gov', 'co.uk', 'net', 'io'];
    };

    Chance.prototype.tld = function () {
        return this.pick(this.tlds());
    };

    Chance.prototype.twitter = function () {
        return '@' + this.word();
    };

    Chance.prototype.url = function (options) {
        options = initOptions(options, { protocol: "http", domain: this.domain(options), domain_prefix: "", path: this.word(), extensions: []});

        var extension = options.extensions.length > 0 ? "." + this.pick(options.extensions) : "";
        var domain = options.domain_prefix ? options.domain_prefix + "." + options.domain : options.domain;

        return options.protocol + "://" + domain + "/" + options.path + extension;
    };

    // -- End Web --

    // -- Location --

    Chance.prototype.address = function (options) {
        options = initOptions(options);
        return this.natural({min: 5, max: 2000}) + ' ' + this.street(options);
    };

    Chance.prototype.altitude = function (options) {
        options = initOptions(options, {fixed: 5, min: 0, max: 8848});
        return this.floating({
            min: options.min,
            max: options.max,
            fixed: options.fixed
        });
    };

    Chance.prototype.areacode = function (options) {
        options = initOptions(options, {parens : true});
        // Don't want area codes to start with 1, or have a 9 as the second digit
        var areacode = this.natural({min: 2, max: 9}).toString() +
                this.natural({min: 0, max: 8}).toString() +
                this.natural({min: 0, max: 9}).toString();

        return options.parens ? '(' + areacode + ')' : areacode;
    };

    Chance.prototype.city = function () {
        return this.capitalize(this.word({syllables: 3}));
    };

    Chance.prototype.coordinates = function (options) {
        return this.latitude(options) + ', ' + this.longitude(options);
    };

    Chance.prototype.countries = function () {
        return this.get("countries");
    };

    Chance.prototype.country = function (options) {
        options = initOptions(options);
        var country = this.pick(this.countries());
        return options.full ? country.name : country.abbreviation;
    };

    Chance.prototype.depth = function (options) {
        options = initOptions(options, {fixed: 5, min: -10994, max: 0});
        return this.floating({
            min: options.min,
            max: options.max,
            fixed: options.fixed
        });
    };

    Chance.prototype.geohash = function (options) {
        options = initOptions(options, { length: 7 });
        return this.string({ length: options.length, pool: '0123456789bcdefghjkmnpqrstuvwxyz' });
    };

    Chance.prototype.geojson = function (options) {
        return this.latitude(options) + ', ' + this.longitude(options) + ', ' + this.altitude(options);
    };

    Chance.prototype.latitude = function (options) {
        options = initOptions(options, {fixed: 5, min: -90, max: 90});
        return this.floating({min: options.min, max: options.max, fixed: options.fixed});
    };

    Chance.prototype.longitude = function (options) {
        options = initOptions(options, {fixed: 5, min: -180, max: 180});
        return this.floating({min: options.min, max: options.max, fixed: options.fixed});
    };

    Chance.prototype.phone = function (options) {
        var self = this,
            numPick,
            ukNum = function (parts) {
                var section = [];
                //fills the section part of the phone number with random numbers.
                parts.sections.forEach(function(n) {
                    section.push(self.string({ pool: '0123456789', length: n}));
                });
                return parts.area + section.join(' ');
            };
        options = initOptions(options, {
            formatted: true,
            country: 'us',
            mobile: false
        });
        if (!options.formatted) {
            options.parens = false;
        }
        var phone;
        switch (options.country) {
            case 'fr':
                if (!options.mobile) {
                    numPick = this.pick([
                        // Valid zone and département codes.
                        '01' + this.pick(['30', '34', '39', '40', '41', '42', '43', '44', '45', '46', '47', '48', '49', '53', '55', '56', '58', '60', '64', '69', '70', '72', '73', '74', '75', '76', '77', '78', '79', '80', '81', '82', '83']) + self.string({ pool: '0123456789', length: 6}),
                        '02' + this.pick(['14', '18', '22', '23', '28', '29', '30', '31', '32', '33', '34', '35', '36', '37', '38', '40', '41', '43', '44', '45', '46', '47', '48', '49', '50', '51', '52', '53', '54', '56', '57', '61', '62', '69', '72', '76', '77', '78', '85', '90', '96', '97', '98', '99']) + self.string({ pool: '0123456789', length: 6}),
                        '03' + this.pick(['10', '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '39', '44', '45', '51', '52', '54', '55', '57', '58', '59', '60', '61', '62', '63', '64', '65', '66', '67', '68', '69', '70', '71', '72', '73', '80', '81', '82', '83', '84', '85', '86', '87', '88', '89', '90']) + self.string({ pool: '0123456789', length: 6}),
                        '04' + this.pick(['11', '13', '15', '20', '22', '26', '27', '30', '32', '34', '37', '42', '43', '44', '50', '56', '57', '63', '66', '67', '68', '69', '70', '71', '72', '73', '74', '75', '76', '77', '78', '79', '80', '81', '82', '83', '84', '85', '86', '88', '89', '90', '91', '92', '93', '94', '95', '97', '98']) + self.string({ pool: '0123456789', length: 6}),
                        '05' + this.pick(['08', '16', '17', '19', '24', '31', '32', '33', '34', '35', '40', '45', '46', '47', '49', '53', '55', '56', '57', '58', '59', '61', '62', '63', '64', '65', '67', '79', '81', '82', '86', '87', '90', '94']) + self.string({ pool: '0123456789', length: 6}),
                        '09' + self.string({ pool: '0123456789', length: 8}),
                    ]);
                    phone = options.formatted ? numPick.match(/../g).join(' ') : numPick;
                } else {
                    numPick = this.pick(['06', '07']) + self.string({ pool: '0123456789', length: 8});
                    phone = options.formatted ? numPick.match(/../g).join(' ') : numPick;
                }
                break;
            case 'uk':
                if (!options.mobile) {
                    numPick = this.pick([
                        //valid area codes of major cities/counties followed by random numbers in required format.
                        { area: '01' + this.character({ pool: '234569' }) + '1 ', sections: [3,4] },
                        { area: '020 ' + this.character({ pool: '378' }), sections: [3,4] },
                        { area: '023 ' + this.character({ pool: '89' }), sections: [3,4] },
                        { area: '024 7', sections: [3,4] },
                        { area: '028 ' + this.pick(['25','28','37','71','82','90','92','95']), sections: [2,4] },
                        { area: '012' + this.pick(['04','08','54','76','97','98']) + ' ', sections: [5] },
                        { area: '013' + this.pick(['63','64','84','86']) + ' ', sections: [5] },
                        { area: '014' + this.pick(['04','20','60','61','80','88']) + ' ', sections: [5] },
                        { area: '015' + this.pick(['24','27','62','66']) + ' ', sections: [5] },
                        { area: '016' + this.pick(['06','29','35','47','59','95']) + ' ', sections: [5] },
                        { area: '017' + this.pick(['26','44','50','68']) + ' ', sections: [5] },
                        { area: '018' + this.pick(['27','37','84','97']) + ' ', sections: [5] },
                        { area: '019' + this.pick(['00','05','35','46','49','63','95']) + ' ', sections: [5] }
                    ]);
                    phone = options.formatted ? ukNum(numPick) : ukNum(numPick).replace(' ', '', 'g');
                } else {
                    numPick = this.pick([
                        { area: '07' + this.pick(['4','5','7','8','9']), sections: [2,6] },
                        { area: '07624 ', sections: [6] }
                    ]);
                    phone = options.formatted ? ukNum(numPick) : ukNum(numPick).replace(' ', '');
                }
                break;
            case 'us':
                var areacode = this.areacode(options).toString();
                var exchange = this.natural({ min: 2, max: 9 }).toString() +
                    this.natural({ min: 0, max: 9 }).toString() +
                    this.natural({ min: 0, max: 9 }).toString();
                var subscriber = this.natural({ min: 1000, max: 9999 }).toString(); // this could be random [0-9]{4}
                phone = options.formatted ? areacode + ' ' + exchange + '-' + subscriber : areacode + exchange + subscriber;
        }
        return phone;
    };

    Chance.prototype.postal = function () {
        // Postal District
        var pd = this.character({pool: "XVTSRPNKLMHJGECBA"});
        // Forward Sortation Area (FSA)
        var fsa = pd + this.natural({max: 9}) + this.character({alpha: true, casing: "upper"});
        // Local Delivery Unut (LDU)
        var ldu = this.natural({max: 9}) + this.character({alpha: true, casing: "upper"}) + this.natural({max: 9});

        return fsa + " " + ldu;
    };

    Chance.prototype.provinces = function () {
        return this.get("provinces");
    };

    Chance.prototype.province = function (options) {
        return (options && options.full) ?
            this.pick(this.provinces()).name :
            this.pick(this.provinces()).abbreviation;
    };

    Chance.prototype.state = function (options) {
        return (options && options.full) ?
            this.pick(this.states(options)).name :
            this.pick(this.states(options)).abbreviation;
    };

    Chance.prototype.states = function (options) {
        options = initOptions(options, { us_states_and_dc: true });

        var states,
            us_states_and_dc = this.get("us_states_and_dc"),
            territories = this.get("territories"),
            armed_forces = this.get("armed_forces");

        states = [];

        if (options.us_states_and_dc) {
            states = states.concat(us_states_and_dc);
        }
        if (options.territories) {
            states = states.concat(territories);
        }
        if (options.armed_forces) {
            states = states.concat(armed_forces);
        }

        return states;
    };

    Chance.prototype.street = function (options) {
        options = initOptions(options);

        var street = this.word({syllables: 2});
        street = this.capitalize(street);
        street += ' ';
        street += options.short_suffix ?
            this.street_suffix().abbreviation :
            this.street_suffix().name;
        return street;
    };

    Chance.prototype.street_suffix = function () {
        return this.pick(this.street_suffixes());
    };

    Chance.prototype.street_suffixes = function () {
        // These are the most common suffixes.
        return this.get("street_suffixes");
    };

    // Note: only returning US zip codes, internationalization will be a whole
    // other beast to tackle at some point.
    Chance.prototype.zip = function (options) {
        var zip = this.n(this.natural, 5, {max: 9});

        if (options && options.plusfour === true) {
            zip.push('-');
            zip = zip.concat(this.n(this.natural, 4, {max: 9}));
        }

        return zip.join("");
    };

    // -- End Location --

    // -- Time

    Chance.prototype.ampm = function () {
        return this.bool() ? 'am' : 'pm';
    };

    Chance.prototype.date = function (options) {
        var date_string, date;

        // If interval is specified we ignore preset
        if(options && (options.min || options.max)) {
            options = initOptions(options, {
                american: true,
                string: false
            });
            var min = typeof options.min !== "undefined" ? options.min.getTime() : 1;
            // 100,000,000 days measured relative to midnight at the beginning of 01 January, 1970 UTC. http://es5.github.io/#x15.9.1.1
            var max = typeof options.max !== "undefined" ? options.max.getTime() : 8640000000000000;

            date = new Date(this.natural({min: min, max: max}));
        } else {
            var m = this.month({raw: true});
            var daysInMonth = m.days;

            if(options && options.month) {
                // Mod 12 to allow months outside range of 0-11 (not encouraged, but also not prevented).
                daysInMonth = this.get('months')[((options.month % 12) + 12) % 12].days;
            }

            options = initOptions(options, {
                year: parseInt(this.year(), 10),
                // Necessary to subtract 1 because Date() 0-indexes month but not day or year
                // for some reason.
                month: m.numeric - 1,
                day: this.natural({min: 1, max: daysInMonth}),
                hour: this.hour(),
                minute: this.minute(),
                second: this.second(),
                millisecond: this.millisecond(),
                american: true,
                string: false
            });

            date = new Date(options.year, options.month, options.day, options.hour, options.minute, options.second, options.millisecond);
        }

        if (options.american) {
            // Adding 1 to the month is necessary because Date() 0-indexes
            // months but not day for some odd reason.
            date_string = (date.getMonth() + 1) + '/' + date.getDate() + '/' + date.getFullYear();
        } else {
            date_string = date.getDate() + '/' + (date.getMonth() + 1) + '/' + date.getFullYear();
        }

        return options.string ? date_string : date;
    };

    Chance.prototype.hammertime = function (options) {
        return this.date(options).getTime();
    };

    Chance.prototype.hour = function (options) {
        options = initOptions(options, {
            min: options && options.twentyfour ? 0 : 1,
            max: options && options.twentyfour ? 23 : 12
        });

        testRange(options.min < 0, "Chance: Min cannot be less than 0.");
        testRange(options.twentyfour && options.max > 23, "Chance: Max cannot be greater than 23 for twentyfour option.");
        testRange(!options.twentyfour && options.max > 12, "Chance: Max cannot be greater than 12.");
        testRange(options.min > options.max, "Chance: Min cannot be greater than Max.");

        return this.natural({min: options.min, max: options.max});
    };

    Chance.prototype.millisecond = function () {
        return this.natural({max: 999});
    };

    Chance.prototype.minute = Chance.prototype.second = function (options) {
        options = initOptions(options, {min: 0, max: 59});

        testRange(options.min < 0, "Chance: Min cannot be less than 0.");
        testRange(options.max > 59, "Chance: Max cannot be greater than 59.");
        testRange(options.min > options.max, "Chance: Min cannot be greater than Max.");

        return this.natural({min: options.min, max: options.max});
    };

    Chance.prototype.month = function (options) {
        options = initOptions(options, {min: 1, max: 12});

        testRange(options.min < 1, "Chance: Min cannot be less than 1.");
        testRange(options.max > 12, "Chance: Max cannot be greater than 12.");
        testRange(options.min > options.max, "Chance: Min cannot be greater than Max.");

        var month = this.pick(this.months().slice(options.min - 1, options.max));
        return options.raw ? month : month.name;
    };

    Chance.prototype.months = function () {
        return this.get("months");
    };

    Chance.prototype.second = function () {
        return this.natural({max: 59});
    };

    Chance.prototype.timestamp = function () {
        return this.natural({min: 1, max: parseInt(new Date().getTime() / 1000, 10)});
    };

    Chance.prototype.weekday = function (options) {
        options = initOptions(options, {weekday_only: false});
        var weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
        if (!options.weekday_only) {
            weekdays.push("Saturday");
            weekdays.push("Sunday");
        }
        return this.pickone(weekdays);
    };

    Chance.prototype.year = function (options) {
        // Default to current year as min if none specified
        options = initOptions(options, {min: new Date().getFullYear()});

        // Default to one century after current year as max if none specified
        options.max = (typeof options.max !== "undefined") ? options.max : options.min + 100;

        return this.natural(options).toString();
    };

    // -- End Time

    // -- Finance --

    Chance.prototype.cc = function (options) {
        options = initOptions(options);

        var type, number, to_generate;

        type = (options.type) ?
                    this.cc_type({ name: options.type, raw: true }) :
                    this.cc_type({ raw: true });

        number = type.prefix.split("");
        to_generate = type.length - type.prefix.length - 1;

        // Generates n - 1 digits
        number = number.concat(this.n(this.integer, to_generate, {min: 0, max: 9}));

        // Generates the last digit according to Luhn algorithm
        number.push(this.luhn_calculate(number.join("")));

        return number.join("");
    };

    Chance.prototype.cc_types = function () {
        // http://en.wikipedia.org/wiki/Bank_card_number#Issuer_identification_number_.28IIN.29
        return this.get("cc_types");
    };

    Chance.prototype.cc_type = function (options) {
        options = initOptions(options);
        var types = this.cc_types(),
            type = null;

        if (options.name) {
            for (var i = 0; i < types.length; i++) {
                // Accept either name or short_name to specify card type
                if (types[i].name === options.name || types[i].short_name === options.name) {
                    type = types[i];
                    break;
                }
            }
            if (type === null) {
                throw new RangeError("Credit card type '" + options.name + "'' is not supported");
            }
        } else {
            type = this.pick(types);
        }

        return options.raw ? type : type.name;
    };

    //return all world currency by ISO 4217
    Chance.prototype.currency_types = function () {
        return this.get("currency_types");
    };

    //return random world currency by ISO 4217
    Chance.prototype.currency = function () {
        return this.pick(this.currency_types());
    };

    //Return random correct currency exchange pair (e.g. EUR/USD) or array of currency code
    Chance.prototype.currency_pair = function (returnAsString) {
        var currencies = this.unique(this.currency, 2, {
            comparator: function(arr, val) {

                return arr.reduce(function(acc, item) {
                    // If a match has been found, short circuit check and just return
                    return acc || (item.code === val.code);
                }, false);
            }
        });

        if (returnAsString) {
            return currencies[0].code + '/' + currencies[1].code;
        } else {
            return currencies;
        }
    };

    Chance.prototype.dollar = function (options) {
        // By default, a somewhat more sane max for dollar than all available numbers
        options = initOptions(options, {max : 10000, min : 0});

        var dollar = this.floating({min: options.min, max: options.max, fixed: 2}).toString(),
            cents = dollar.split('.')[1];

        if (cents === undefined) {
            dollar += '.00';
        } else if (cents.length < 2) {
            dollar = dollar + '0';
        }

        if (dollar < 0) {
            return '-$' + dollar.replace('-', '');
        } else {
            return '$' + dollar;
        }
    };

    Chance.prototype.exp = function (options) {
        options = initOptions(options);
        var exp = {};

        exp.year = this.exp_year();

        // If the year is this year, need to ensure month is greater than the
        // current month or this expiration will not be valid
        if (exp.year === (new Date().getFullYear()).toString()) {
            exp.month = this.exp_month({future: true});
        } else {
            exp.month = this.exp_month();
        }

        return options.raw ? exp : exp.month + '/' + exp.year;
    };

    Chance.prototype.exp_month = function (options) {
        options = initOptions(options);
        var month, month_int,
            // Date object months are 0 indexed
            curMonth = new Date().getMonth() + 1;

        if (options.future) {
            do {
                month = this.month({raw: true}).numeric;
                month_int = parseInt(month, 10);
            } while (month_int <= curMonth);
        } else {
            month = this.month({raw: true}).numeric;
        }

        return month;
    };

    Chance.prototype.exp_year = function () {
        return this.year({max: new Date().getFullYear() + 10});
    };

    // -- End Finance

    // -- Regional

    Chance.prototype.pl_pesel = function () {
        var number = this.natural({min: 1, max: 9999999999});
        var arr = this.pad(number, 10).split('');
        for (var i = 0; i < arr.length; i++) {
            arr[i] = parseInt(arr[i]);
        }

        var controlNumber = (1 * arr[0] + 3 * arr[1] + 7 * arr[2] + 9 * arr[3] + 1 * arr[4] + 3 * arr[5] + 7 * arr[6] + 9 * arr[7] + 1 * arr[8] + 3 * arr[9]) % 10;
        if(controlNumber !== 0) {
            controlNumber = 10 - controlNumber;
        }

        return arr.join('') + controlNumber;
    };

    Chance.prototype.pl_nip = function () {
        var number = this.natural({min: 1, max: 999999999});
        var arr = this.pad(number, 9).split('');
        for (var i = 0; i < arr.length; i++) {
            arr[i] = parseInt(arr[i]);
        }

        var controlNumber = (6 * arr[0] + 5 * arr[1] + 7 * arr[2] + 2 * arr[3] + 3 * arr[4] + 4 * arr[5] + 5 * arr[6] + 6 * arr[7] + 7 * arr[8]) % 11;
        if(controlNumber === 10) {
            return this.pl_nip();
        }

        return arr.join('') + controlNumber;
    };

    Chance.prototype.pl_regon = function () {
        var number = this.natural({min: 1, max: 99999999});
        var arr = this.pad(number, 8).split('');
        for (var i = 0; i < arr.length; i++) {
            arr[i] = parseInt(arr[i]);
        }

        var controlNumber = (8 * arr[0] + 9 * arr[1] + 2 * arr[2] + 3 * arr[3] + 4 * arr[4] + 5 * arr[5] + 6 * arr[6] + 7 * arr[7]) % 11;
        if(controlNumber === 10) {
            controlNumber = 0;
        }

        return arr.join('') + controlNumber;
    };

    // -- End Regional

    // -- Miscellaneous --

    // Dice - For all the board game geeks out there, myself included ;)
    function diceFn (range) {
        return function () {
            return this.natural(range);
        };
    }
    Chance.prototype.d4 = diceFn({min: 1, max: 4});
    Chance.prototype.d6 = diceFn({min: 1, max: 6});
    Chance.prototype.d8 = diceFn({min: 1, max: 8});
    Chance.prototype.d10 = diceFn({min: 1, max: 10});
    Chance.prototype.d12 = diceFn({min: 1, max: 12});
    Chance.prototype.d20 = diceFn({min: 1, max: 20});
    Chance.prototype.d30 = diceFn({min: 1, max: 30});
    Chance.prototype.d100 = diceFn({min: 1, max: 100});

    Chance.prototype.rpg = function (thrown, options) {
        options = initOptions(options);
        if (!thrown) {
            throw new RangeError("A type of die roll must be included");
        } else {
            var bits = thrown.toLowerCase().split("d"),
                rolls = [];

            if (bits.length !== 2 || !parseInt(bits[0], 10) || !parseInt(bits[1], 10)) {
                throw new Error("Invalid format provided. Please provide #d# where the first # is the number of dice to roll, the second # is the max of each die");
            }
            for (var i = bits[0]; i > 0; i--) {
                rolls[i - 1] = this.natural({min: 1, max: bits[1]});
            }
            return (typeof options.sum !== 'undefined' && options.sum) ? rolls.reduce(function (p, c) { return p + c; }) : rolls;
        }
    };

    // Guid
    Chance.prototype.guid = function (options) {
        options = initOptions(options, { version: 5 });

        var guid_pool = "abcdef1234567890",
            variant_pool = "ab89",
            guid = this.string({ pool: guid_pool, length: 8 }) + '-' +
                   this.string({ pool: guid_pool, length: 4 }) + '-' +
                   // The Version
                   options.version +
                   this.string({ pool: guid_pool, length: 3 }) + '-' +
                   // The Variant
                   this.string({ pool: variant_pool, length: 1 }) +
                   this.string({ pool: guid_pool, length: 3 }) + '-' +
                   this.string({ pool: guid_pool, length: 12 });
        return guid;
    };

    // Hash
    Chance.prototype.hash = function (options) {
        options = initOptions(options, {length : 40, casing: 'lower'});
        var pool = options.casing === 'upper' ? HEX_POOL.toUpperCase() : HEX_POOL;
        return this.string({pool: pool, length: options.length});
    };

    Chance.prototype.luhn_check = function (num) {
        var str = num.toString();
        var checkDigit = +str.substring(str.length - 1);
        return checkDigit === this.luhn_calculate(+str.substring(0, str.length - 1));
    };

    Chance.prototype.luhn_calculate = function (num) {
        var digits = num.toString().split("").reverse();
        var sum = 0;
        var digit;

        for (var i = 0, l = digits.length; l > i; ++i) {
            digit = +digits[i];
            if (i % 2 === 0) {
                digit *= 2;
                if (digit > 9) {
                    digit -= 9;
                }
            }
            sum += digit;
        }
        return (sum * 9) % 10;
    };

    // MD5 Hash
    Chance.prototype.md5 = function(options) {
        var opts = { str: '', key: null, raw: false };

        if (!options) {
            opts.str = this.string();
            options = {};
        }
        else if (typeof options === 'string') {
            opts.str = options;
            options = {};
        }
        else if (typeof options !== 'object') {
            return null;
        }
        else if(options.constructor === 'Array') {
            return null;
        }

        opts = initOptions(options, opts);

        if(!opts.str){
            throw new Error('A parameter is required to return an md5 hash.');
        }

        return this.bimd5.md5(opts.str, opts.key, opts.raw);
    };

    /**
     * #Description:
     * =====================================================
     * Generate random file name with extention
     *
     * The argument provide extention type 
     * -> raster 
     * -> vector
     * -> 3d
     * -> document
     *
     * If noting is provided the function return random file name with random 
     * extention type of any kind
     *
     * The user can validate the file name length range 
     * If noting provided the generated file name is radom
     *
     * #Extention Pool :
     * * Currently the supported extentions are 
     *  -> some of the most popular raster image extentions
     *  -> some of the most popular vector image extentions
     *  -> some of the most popular 3d image extentions
     *  -> some of the most popular document extentions
     * 
     * #Examples :
     * =====================================================
     *
     * Return random file name with random extention. The file extention
     * is provided by a predifined collection of extentions. More abouth the extention
     * pool can be fond in #Extention Pool section
     * 
     * chance.file()                        
     * => dsfsdhjf.xml
     *
     * In order to generate a file name with sspecific length, specify the 
     * length property and integer value. The extention is going to be random
     *  
     * chance.file({length : 10})           
     * => asrtineqos.pdf
     *
     * In order to geerate file with extention form some of the predifined groups
     * of the extention pool just specify the extenton pool category in fileType property
     *  
     * chance.file({fileType : 'raster'})   
     * => dshgssds.psd
     *
     * You can provide specific extention for your files
     * chance.file({extention : 'html'})    
     * => djfsd.html
     *
     * Or you could pass custom collection of extentons bt array or by object
     * chance.file({extentions : [...]})    
     * => dhgsdsd.psd
     *  
     * chance.file({extentions : { key : [...], key : [...]}})
     * => djsfksdjsd.xml
     * 
     * @param  [collection] options 
     * @return [string]
     * 
     */
    Chance.prototype.file = function(options) {
        
        var fileOptions = options || {};
        var poolCollectionKey = "fileExtension";
        var typeRange   = Object.keys(this.get("fileExtension"));//['raster', 'vector', '3d', 'document'];
        var fileName;
        var fileExtention;

        // Generate random file name 
        fileName = this.word({length : fileOptions.length});

        // Generate file by specific extention provided by the user
        if(fileOptions.extention) {

            fileExtention = fileOptions.extention;
            return (fileName + '.' + fileExtention);
        }

        // Generate file by specific axtention collection
        if(fileOptions.extentions) {

            if(Array.isArray(fileOptions.extentions)) {

                fileExtention = this.pickone(fileOptions.extentions);
                return (fileName + '.' + fileExtention);
            }
            else if(fileOptions.extentions.constructor === Object) {
                
                var extentionObjectCollection = fileOptions.extentions;
                var keys = Object.keys(extentionObjectCollection);

                fileExtention = this.pickone(extentionObjectCollection[this.pickone(keys)]);
                return (fileName + '.' + fileExtention);
            }

            throw new Error("Expect collection of type Array or Object to be passed as an argument ");
        } 

        // Generate file extention based on specific file type
        if(fileOptions.fileType) {

            var fileType = fileOptions.fileType;
            if(typeRange.indexOf(fileType) !== -1) {

                fileExtention = this.pickone(this.get(poolCollectionKey)[fileType]);
                return (fileName + '.' + fileExtention);
            }

            throw new Error("Expect file type value to be 'raster', 'vector', '3d' or 'document' ");
        }

        // Generate random file name if no extenton options are passed
        fileExtention = this.pickone(this.get(poolCollectionKey)[this.pickone(typeRange)]);
        return (fileName + '.' + fileExtention);
    };     

    var data = {

        firstNames: {
            "male": {
                "en": ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Charles", "Thomas", "Christopher", "Daniel", "Matthew", "George", "Donald", "Anthony", "Paul", "Mark", "Edward", "Steven", "Kenneth", "Andrew", "Brian", "Joshua", "Kevin", "Ronald", "Timothy", "Jason", "Jeffrey", "Frank", "Gary", "Ryan", "Nicholas", "Eric", "Stephen", "Jacob", "Larry", "Jonathan", "Scott", "Raymond", "Justin", "Brandon", "Gregory", "Samuel", "Benjamin", "Patrick", "Jack", "Henry", "Walter", "Dennis", "Jerry", "Alexander", "Peter", "Tyler", "Douglas", "Harold", "Aaron", "Jose", "Adam", "Arthur", "Zachary", "Carl", "Nathan", "Albert", "Kyle", "Lawrence", "Joe", "Willie", "Gerald", "Roger", "Keith", "Jeremy", "Terry", "Harry", "Ralph", "Sean", "Jesse", "Roy", "Louis", "Billy", "Austin", "Bruce", "Eugene", "Christian", "Bryan", "Wayne", "Russell", "Howard", "Fred", "Ethan", "Jordan", "Philip", "Alan", "Juan", "Randy", "Vincent", "Bobby", "Dylan", "Johnny", "Phillip", "Victor", "Clarence", "Ernest", "Martin", "Craig", "Stanley", "Shawn", "Travis", "Bradley", "Leonard", "Earl", "Gabriel", "Jimmy", "Francis", "Todd", "Noah", "Danny", "Dale", "Cody", "Carlos", "Allen", "Frederick", "Logan", "Curtis", "Alex", "Joel", "Luis", "Norman", "Marvin", "Glenn", "Tony", "Nathaniel", "Rodney", "Melvin", "Alfred", "Steve", "Cameron", "Chad", "Edwin", "Caleb", "Evan", "Antonio", "Lee", "Herbert", "Jeffery", "Isaac", "Derek", "Ricky", "Marcus", "Theodore", "Elijah", "Luke", "Jesus", "Eddie", "Troy", "Mike", "Dustin", "Ray", "Adrian", "Bernard", "Leroy", "Angel", "Randall", "Wesley", "Ian", "Jared", "Mason", "Hunter", "Calvin", "Oscar", "Clifford", "Jay", "Shane", "Ronnie", "Barry", "Lucas", "Corey", "Manuel", "Leo", "Tommy", "Warren", "Jackson", "Isaiah", "Connor", "Don", "Dean", "Jon", "Julian", "Miguel", "Bill", "Lloyd", "Charlie", "Mitchell", "Leon", "Jerome", "Darrell", "Jeremiah", "Alvin", "Brett", "Seth", "Floyd", "Jim", "Blake", "Micheal", "Gordon", "Trevor", "Lewis", "Erik", "Edgar", "Vernon", "Devin", "Gavin", "Jayden", "Chris", "Clyde", "Tom", "Derrick", "Mario", "Brent", "Marc", "Herman", "Chase", "Dominic", "Ricardo", "Franklin", "Maurice", "Max", "Aiden", "Owen", "Lester", "Gilbert", "Elmer", "Gene", "Francisco", "Glen", "Cory", "Garrett", "Clayton", "Sam", "Jorge", "Chester", "Alejandro", "Jeff", "Harvey", "Milton", "Cole", "Ivan", "Andre", "Duane", "Landon"],
                "it": ["Francesco", "Alessandro", "Lorenzo", "Andrea", "Marco", "Leonardo", "Matteo", "Federico", "Mattia", "Riccardo", "Luca", "Davide", "Gabriele", "Edoardo", "Tommaso", "Giacomo", "Simone", "Christian", "Stefano", "Diego", "Filippo", "Giuseppe"]
            },
            "female": {
                "en": ["Mary", "Emma", "Elizabeth", "Minnie", "Margaret", "Ida", "Alice", "Bertha", "Sarah", "Annie", "Clara", "Ella", "Florence", "Cora", "Martha", "Laura", "Nellie", "Grace", "Carrie", "Maude", "Mabel", "Bessie", "Jennie", "Gertrude", "Julia", "Hattie", "Edith", "Mattie", "Rose", "Catherine", "Lillian", "Ada", "Lillie", "Helen", "Jessie", "Louise", "Ethel", "Lula", "Myrtle", "Eva", "Frances", "Lena", "Lucy", "Edna", "Maggie", "Pearl", "Daisy", "Fannie", "Josephine", "Dora", "Rosa", "Katherine", "Agnes", "Marie", "Nora", "May", "Mamie", "Blanche", "Stella", "Ellen", "Nancy", "Effie", "Sallie", "Nettie", "Della", "Lizzie", "Flora", "Susie", "Maud", "Mae", "Etta", "Harriet", "Sadie", "Caroline", "Katie", "Lydia", "Elsie", "Kate", "Susan", "Mollie", "Alma", "Addie", "Georgia", "Eliza", "Lulu", "Nannie", "Lottie", "Amanda", "Belle", "Charlotte", "Rebecca", "Ruth", "Viola", "Olive", "Amelia", "Hannah", "Jane", "Virginia", "Emily", "Matilda", "Irene", "Kathryn", "Esther", "Willie", "Henrietta", "Ollie", "Amy", "Rachel", "Sara", "Estella", "Theresa", "Augusta", "Ora", "Pauline", "Josie", "Lola", "Sophia", "Leona", "Anne", "Mildred", "Ann", "Beulah", "Callie", "Lou", "Delia", "Eleanor", "Barbara", "Iva", "Louisa", "Maria", "Mayme", "Evelyn", "Estelle", "Nina", "Betty", "Marion", "Bettie", "Dorothy", "Luella", "Inez", "Lela", "Rosie", "Allie", "Millie", "Janie", "Cornelia", "Victoria", "Ruby", "Winifred", "Alta", "Celia", "Christine", "Beatrice", "Birdie", "Harriett", "Mable", "Myra", "Sophie", "Tillie", "Isabel", "Sylvia", "Carolyn", "Isabelle", "Leila", "Sally", "Ina", "Essie", "Bertie", "Nell", "Alberta", "Katharine", "Lora", "Rena", "Mina", "Rhoda", "Mathilda", "Abbie", "Eula", "Dollie", "Hettie", "Eunice", "Fanny", "Ola", "Lenora", "Adelaide", "Christina", "Lelia", "Nelle", "Sue", "Johanna", "Lilly", "Lucinda", "Minerva", "Lettie", "Roxie", "Cynthia", "Helena", "Hilda", "Hulda", "Bernice", "Genevieve", "Jean", "Cordelia", "Marian", "Francis", "Jeanette", "Adeline", "Gussie", "Leah", "Lois", "Lura", "Mittie", "Hallie", "Isabella", "Olga", "Phoebe", "Teresa", "Hester", "Lida", "Lina", "Winnie", "Claudia", "Marguerite", "Vera", "Cecelia", "Bess", "Emilie", "John", "Rosetta", "Verna", "Myrtie", "Cecilia", "Elva", "Olivia", "Ophelia", "Georgie", "Elnora", "Violet", "Adele", "Lily", "Linnie", "Loretta", "Madge", "Polly", "Virgie", "Eugenia", "Lucile", "Lucille", "Mabelle", "Rosalie"],
                "it": ["Sofia", "Giulia", "Martina", "Giorgia", "Emma", "Chiara", "Aurora", "Sara", "Alice", "Beatrice", "Ginevra", "Elena", "Alessia", "Greta", "Francesca", "Eleonora", "Viola", "Anna", "Elisa", "Giada", "Matilde", "Laura", "Nicole", "Asia", "Camilla", "Arianna", "Rachele", "Rebecca", "Gaia"]
            }
        },

        lastNames: {
            "en": ['Smith', 'Johnson', 'Williams', 'Jones', 'Brown', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson', 'Garcia', 'Martinez', 'Robinson', 'Clark', 'Rodriguez', 'Lewis', 'Lee', 'Walker', 'Hall', 'Allen', 'Young', 'Hernandez', 'King', 'Wright', 'Lopez', 'Hill', 'Scott', 'Green', 'Adams', 'Baker', 'Gonzalez', 'Nelson', 'Carter', 'Mitchell', 'Perez', 'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart', 'Sanchez', 'Morris', 'Rogers', 'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy', 'Bailey', 'Rivera', 'Cooper', 'Richardson', 'Cox', 'Howard', 'Ward', 'Torres', 'Peterson', 'Gray', 'Ramirez', 'James', 'Watson', 'Brooks', 'Kelly', 'Sanders', 'Price', 'Bennett', 'Wood', 'Barnes', 'Ross', 'Henderson', 'Coleman', 'Jenkins', 'Perry', 'Powell', 'Long', 'Patterson', 'Hughes', 'Flores', 'Washington', 'Butler', 'Simmons', 'Foster', 'Gonzales', 'Bryant', 'Alexander', 'Russell', 'Griffin', 'Diaz', 'Hayes', 'Myers', 'Ford', 'Hamilton', 'Graham', 'Sullivan', 'Wallace', 'Woods', 'Cole', 'West', 'Jordan', 'Owens', 'Reynolds', 'Fisher', 'Ellis', 'Harrison', 'Gibson', 'McDonald', 'Cruz', 'Marshall', 'Ortiz', 'Gomez', 'Murray', 'Freeman', 'Wells', 'Webb', 'Simpson', 'Stevens', 'Tucker', 'Porter', 'Hunter', 'Hicks', 'Crawford', 'Henry', 'Boyd', 'Mason', 'Morales', 'Kennedy', 'Warren', 'Dixon', 'Ramos', 'Reyes', 'Burns', 'Gordon', 'Shaw', 'Holmes', 'Rice', 'Robertson', 'Hunt', 'Black', 'Daniels', 'Palmer', 'Mills', 'Nichols', 'Grant', 'Knight', 'Ferguson', 'Rose', 'Stone', 'Hawkins', 'Dunn', 'Perkins', 'Hudson', 'Spencer', 'Gardner', 'Stephens', 'Payne', 'Pierce', 'Berry', 'Matthews', 'Arnold', 'Wagner', 'Willis', 'Ray', 'Watkins', 'Olson', 'Carroll', 'Duncan', 'Snyder', 'Hart', 'Cunningham', 'Bradley', 'Lane', 'Andrews', 'Ruiz', 'Harper', 'Fox', 'Riley', 'Armstrong', 'Carpenter', 'Weaver', 'Greene', 'Lawrence', 'Elliott', 'Chavez', 'Sims', 'Austin', 'Peters', 'Kelley', 'Franklin', 'Lawson', 'Fields', 'Gutierrez', 'Ryan', 'Schmidt', 'Carr', 'Vasquez', 'Castillo', 'Wheeler', 'Chapman', 'Oliver', 'Montgomery', 'Richards', 'Williamson', 'Johnston', 'Banks', 'Meyer', 'Bishop', 'McCoy', 'Howell', 'Alvarez', 'Morrison', 'Hansen', 'Fernandez', 'Garza', 'Harvey', 'Little', 'Burton', 'Stanley', 'Nguyen', 'George', 'Jacobs', 'Reid', 'Kim', 'Fuller', 'Lynch', 'Dean', 'Gilbert', 'Garrett', 'Romero', 'Welch', 'Larson', 'Frazier', 'Burke', 'Hanson', 'Day', 'Mendoza', 'Moreno', 'Bowman', 'Medina', 'Fowler', 'Brewer', 'Hoffman', 'Carlson', 'Silva', 'Pearson', 'Holland', 'Douglas', 'Fleming', 'Jensen', 'Vargas', 'Byrd', 'Davidson', 'Hopkins', 'May', 'Terry', 'Herrera', 'Wade', 'Soto', 'Walters', 'Curtis', 'Neal', 'Caldwell', 'Lowe', 'Jennings', 'Barnett', 'Graves', 'Jimenez', 'Horton', 'Shelton', 'Barrett', 'Obrien', 'Castro', 'Sutton', 'Gregory', 'McKinney', 'Lucas', 'Miles', 'Craig', 'Rodriquez', 'Chambers', 'Holt', 'Lambert', 'Fletcher', 'Watts', 'Bates', 'Hale', 'Rhodes', 'Pena', 'Beck', 'Newman', 'Haynes', 'McDaniel', 'Mendez', 'Bush', 'Vaughn', 'Parks', 'Dawson', 'Santiago', 'Norris', 'Hardy', 'Love', 'Steele', 'Curry', 'Powers', 'Schultz', 'Barker', 'Guzman', 'Page', 'Munoz', 'Ball', 'Keller', 'Chandler', 'Weber', 'Leonard', 'Walsh', 'Lyons', 'Ramsey', 'Wolfe', 'Schneider', 'Mullins', 'Benson', 'Sharp', 'Bowen', 'Daniel', 'Barber', 'Cummings', 'Hines', 'Baldwin', 'Griffith', 'Valdez', 'Hubbard', 'Salazar', 'Reeves', 'Warner', 'Stevenson', 'Burgess', 'Santos', 'Tate', 'Cross', 'Garner', 'Mann', 'Mack', 'Moss', 'Thornton', 'Dennis', 'McGee', 'Farmer', 'Delgado', 'Aguilar', 'Vega', 'Glover', 'Manning', 'Cohen', 'Harmon', 'Rodgers', 'Robbins', 'Newton', 'Todd', 'Blair', 'Higgins', 'Ingram', 'Reese', 'Cannon', 'Strickland', 'Townsend', 'Potter', 'Goodwin', 'Walton', 'Rowe', 'Hampton', 'Ortega', 'Patton', 'Swanson', 'Joseph', 'Francis', 'Goodman', 'Maldonado', 'Yates', 'Becker', 'Erickson', 'Hodges', 'Rios', 'Conner', 'Adkins', 'Webster', 'Norman', 'Malone', 'Hammond', 'Flowers', 'Cobb', 'Moody', 'Quinn', 'Blake', 'Maxwell', 'Pope', 'Floyd', 'Osborne', 'Paul', 'McCarthy', 'Guerrero', 'Lindsey', 'Estrada', 'Sandoval', 'Gibbs', 'Tyler', 'Gross', 'Fitzgerald', 'Stokes', 'Doyle', 'Sherman', 'Saunders', 'Wise', 'Colon', 'Gill', 'Alvarado', 'Greer', 'Padilla', 'Simon', 'Waters', 'Nunez', 'Ballard', 'Schwartz', 'McBride', 'Houston', 'Christensen', 'Klein', 'Pratt', 'Briggs', 'Parsons', 'McLaughlin', 'Zimmerman', 'French', 'Buchanan', 'Moran', 'Copeland', 'Roy', 'Pittman', 'Brady', 'McCormick', 'Holloway', 'Brock', 'Poole', 'Frank', 'Logan', 'Owen', 'Bass', 'Marsh', 'Drake', 'Wong', 'Jefferson', 'Park', 'Morton', 'Abbott', 'Sparks', 'Patrick', 'Norton', 'Huff', 'Clayton', 'Massey', 'Lloyd', 'Figueroa', 'Carson', 'Bowers', 'Roberson', 'Barton', 'Tran', 'Lamb', 'Harrington', 'Casey', 'Boone', 'Cortez', 'Clarke', 'Mathis', 'Singleton', 'Wilkins', 'Cain', 'Bryan', 'Underwood', 'Hogan', 'McKenzie', 'Collier', 'Luna', 'Phelps', 'McGuire', 'Allison', 'Bridges', 'Wilkerson', 'Nash', 'Summers', 'Atkins'],
            "it": ['Rossi', 'Ferrari', 'Russo', 'Bianchi', 'Esposito', 'Colombo', 'Romano', 'Ricci', 'Gallo', 'Greco', 'Conti', 'Marino', 'De Luca', 'Bruno', 'Costa', 'Giordano', 'Mancini', 'Lombardi', 'Barbieri', 'Moretti', 'Fontana', 'Rizzo', 'Santoro', 'Caruso', 'Mariani', 'Martini', 'Ferrara', 'Galli', 'Rinaldi', 'Leone', 'Serra', 'Conte', 'Villa', 'Marini', 'Ferri', 'Bianco', 'Monti', 'De Santis', 'Parisi', 'Fiore', 'De Angelis', 'Longo', 'Sanna', 'Sala', 'Romeo', 'Martinelli', 'Grassi', 'Neri', 'Marchetti', 'Vitale', 'Mari', 'Gentile', 'Viola', 'Marchi', 'Rossetti', 'Bellini', 'Grasso', 'Fabbri', 'Franco', 'Messina', 'Rosso', 'Rizzi', 'D\'Angelo', 'Morelli', 'Giorgi', 'Riva', 'Mazza', 'De Rosa', 'Testa', 'Coppola', 'Amato', 'Donati', 'Palumbo', 'Ferro', 'Basile', 'Ferraro', 'Franchi', 'Castelli', 'Lombardo', 'Farina', 'Carli', 'Bruni', 'Piras', 'Giuliani', 'Martino', 'Poli', 'Gasparini', 'Montanari', 'Orlando', 'Alberti', 'Bernardi', 'Silvestri', 'Ferretti', 'Pellegrino', 'Sartori', 'Palmieri', 'Cattaneo', 'Benedetti', 'Valenti', 'Bassi', 'Verdi']
        },

        // Data taken from https://github.com/umpirsky/country-list/blob/master/country/cldr/en_US/country.json
        countries: [{"name":"Afghanistan","abbreviation":"AF"},{"name":"Albania","abbreviation":"AL"},{"name":"Algeria","abbreviation":"DZ"},{"name":"American Samoa","abbreviation":"AS"},{"name":"Andorra","abbreviation":"AD"},{"name":"Angola","abbreviation":"AO"},{"name":"Anguilla","abbreviation":"AI"},{"name":"Antarctica","abbreviation":"AQ"},{"name":"Antigua and Barbuda","abbreviation":"AG"},{"name":"Argentina","abbreviation":"AR"},{"name":"Armenia","abbreviation":"AM"},{"name":"Aruba","abbreviation":"AW"},{"name":"Australia","abbreviation":"AU"},{"name":"Austria","abbreviation":"AT"},{"name":"Azerbaijan","abbreviation":"AZ"},{"name":"Bahamas","abbreviation":"BS"},{"name":"Bahrain","abbreviation":"BH"},{"name":"Bangladesh","abbreviation":"BD"},{"name":"Barbados","abbreviation":"BB"},{"name":"Belarus","abbreviation":"BY"},{"name":"Belgium","abbreviation":"BE"},{"name":"Belize","abbreviation":"BZ"},{"name":"Benin","abbreviation":"BJ"},{"name":"Bermuda","abbreviation":"BM"},{"name":"Bhutan","abbreviation":"BT"},{"name":"Bolivia","abbreviation":"BO"},{"name":"Bosnia and Herzegovina","abbreviation":"BA"},{"name":"Botswana","abbreviation":"BW"},{"name":"Bouvet Island","abbreviation":"BV"},{"name":"Brazil","abbreviation":"BR"},{"name":"British Antarctic Territory","abbreviation":"BQ"},{"name":"British Indian Ocean Territory","abbreviation":"IO"},{"name":"British Virgin Islands","abbreviation":"VG"},{"name":"Brunei","abbreviation":"BN"},{"name":"Bulgaria","abbreviation":"BG"},{"name":"Burkina Faso","abbreviation":"BF"},{"name":"Burundi","abbreviation":"BI"},{"name":"Cambodia","abbreviation":"KH"},{"name":"Cameroon","abbreviation":"CM"},{"name":"Canada","abbreviation":"CA"},{"name":"Canton and Enderbury Islands","abbreviation":"CT"},{"name":"Cape Verde","abbreviation":"CV"},{"name":"Cayman Islands","abbreviation":"KY"},{"name":"Central African Republic","abbreviation":"CF"},{"name":"Chad","abbreviation":"TD"},{"name":"Chile","abbreviation":"CL"},{"name":"China","abbreviation":"CN"},{"name":"Christmas Island","abbreviation":"CX"},{"name":"Cocos [Keeling] Islands","abbreviation":"CC"},{"name":"Colombia","abbreviation":"CO"},{"name":"Comoros","abbreviation":"KM"},{"name":"Congo - Brazzaville","abbreviation":"CG"},{"name":"Congo - Kinshasa","abbreviation":"CD"},{"name":"Cook Islands","abbreviation":"CK"},{"name":"Costa Rica","abbreviation":"CR"},{"name":"Croatia","abbreviation":"HR"},{"name":"Cuba","abbreviation":"CU"},{"name":"Cyprus","abbreviation":"CY"},{"name":"Czech Republic","abbreviation":"CZ"},{"name":"Côte d’Ivoire","abbreviation":"CI"},{"name":"Denmark","abbreviation":"DK"},{"name":"Djibouti","abbreviation":"DJ"},{"name":"Dominica","abbreviation":"DM"},{"name":"Dominican Republic","abbreviation":"DO"},{"name":"Dronning Maud Land","abbreviation":"NQ"},{"name":"East Germany","abbreviation":"DD"},{"name":"Ecuador","abbreviation":"EC"},{"name":"Egypt","abbreviation":"EG"},{"name":"El Salvador","abbreviation":"SV"},{"name":"Equatorial Guinea","abbreviation":"GQ"},{"name":"Eritrea","abbreviation":"ER"},{"name":"Estonia","abbreviation":"EE"},{"name":"Ethiopia","abbreviation":"ET"},{"name":"Falkland Islands","abbreviation":"FK"},{"name":"Faroe Islands","abbreviation":"FO"},{"name":"Fiji","abbreviation":"FJ"},{"name":"Finland","abbreviation":"FI"},{"name":"France","abbreviation":"FR"},{"name":"French Guiana","abbreviation":"GF"},{"name":"French Polynesia","abbreviation":"PF"},{"name":"French Southern Territories","abbreviation":"TF"},{"name":"French Southern and Antarctic Territories","abbreviation":"FQ"},{"name":"Gabon","abbreviation":"GA"},{"name":"Gambia","abbreviation":"GM"},{"name":"Georgia","abbreviation":"GE"},{"name":"Germany","abbreviation":"DE"},{"name":"Ghana","abbreviation":"GH"},{"name":"Gibraltar","abbreviation":"GI"},{"name":"Greece","abbreviation":"GR"},{"name":"Greenland","abbreviation":"GL"},{"name":"Grenada","abbreviation":"GD"},{"name":"Guadeloupe","abbreviation":"GP"},{"name":"Guam","abbreviation":"GU"},{"name":"Guatemala","abbreviation":"GT"},{"name":"Guernsey","abbreviation":"GG"},{"name":"Guinea","abbreviation":"GN"},{"name":"Guinea-Bissau","abbreviation":"GW"},{"name":"Guyana","abbreviation":"GY"},{"name":"Haiti","abbreviation":"HT"},{"name":"Heard Island and McDonald Islands","abbreviation":"HM"},{"name":"Honduras","abbreviation":"HN"},{"name":"Hong Kong SAR China","abbreviation":"HK"},{"name":"Hungary","abbreviation":"HU"},{"name":"Iceland","abbreviation":"IS"},{"name":"India","abbreviation":"IN"},{"name":"Indonesia","abbreviation":"ID"},{"name":"Iran","abbreviation":"IR"},{"name":"Iraq","abbreviation":"IQ"},{"name":"Ireland","abbreviation":"IE"},{"name":"Isle of Man","abbreviation":"IM"},{"name":"Israel","abbreviation":"IL"},{"name":"Italy","abbreviation":"IT"},{"name":"Jamaica","abbreviation":"JM"},{"name":"Japan","abbreviation":"JP"},{"name":"Jersey","abbreviation":"JE"},{"name":"Johnston Island","abbreviation":"JT"},{"name":"Jordan","abbreviation":"JO"},{"name":"Kazakhstan","abbreviation":"KZ"},{"name":"Kenya","abbreviation":"KE"},{"name":"Kiribati","abbreviation":"KI"},{"name":"Kuwait","abbreviation":"KW"},{"name":"Kyrgyzstan","abbreviation":"KG"},{"name":"Laos","abbreviation":"LA"},{"name":"Latvia","abbreviation":"LV"},{"name":"Lebanon","abbreviation":"LB"},{"name":"Lesotho","abbreviation":"LS"},{"name":"Liberia","abbreviation":"LR"},{"name":"Libya","abbreviation":"LY"},{"name":"Liechtenstein","abbreviation":"LI"},{"name":"Lithuania","abbreviation":"LT"},{"name":"Luxembourg","abbreviation":"LU"},{"name":"Macau SAR China","abbreviation":"MO"},{"name":"Macedonia","abbreviation":"MK"},{"name":"Madagascar","abbreviation":"MG"},{"name":"Malawi","abbreviation":"MW"},{"name":"Malaysia","abbreviation":"MY"},{"name":"Maldives","abbreviation":"MV"},{"name":"Mali","abbreviation":"ML"},{"name":"Malta","abbreviation":"MT"},{"name":"Marshall Islands","abbreviation":"MH"},{"name":"Martinique","abbreviation":"MQ"},{"name":"Mauritania","abbreviation":"MR"},{"name":"Mauritius","abbreviation":"MU"},{"name":"Mayotte","abbreviation":"YT"},{"name":"Metropolitan France","abbreviation":"FX"},{"name":"Mexico","abbreviation":"MX"},{"name":"Micronesia","abbreviation":"FM"},{"name":"Midway Islands","abbreviation":"MI"},{"name":"Moldova","abbreviation":"MD"},{"name":"Monaco","abbreviation":"MC"},{"name":"Mongolia","abbreviation":"MN"},{"name":"Montenegro","abbreviation":"ME"},{"name":"Montserrat","abbreviation":"MS"},{"name":"Morocco","abbreviation":"MA"},{"name":"Mozambique","abbreviation":"MZ"},{"name":"Myanmar [Burma]","abbreviation":"MM"},{"name":"Namibia","abbreviation":"NA"},{"name":"Nauru","abbreviation":"NR"},{"name":"Nepal","abbreviation":"NP"},{"name":"Netherlands","abbreviation":"NL"},{"name":"Netherlands Antilles","abbreviation":"AN"},{"name":"Neutral Zone","abbreviation":"NT"},{"name":"New Caledonia","abbreviation":"NC"},{"name":"New Zealand","abbreviation":"NZ"},{"name":"Nicaragua","abbreviation":"NI"},{"name":"Niger","abbreviation":"NE"},{"name":"Nigeria","abbreviation":"NG"},{"name":"Niue","abbreviation":"NU"},{"name":"Norfolk Island","abbreviation":"NF"},{"name":"North Korea","abbreviation":"KP"},{"name":"North Vietnam","abbreviation":"VD"},{"name":"Northern Mariana Islands","abbreviation":"MP"},{"name":"Norway","abbreviation":"NO"},{"name":"Oman","abbreviation":"OM"},{"name":"Pacific Islands Trust Territory","abbreviation":"PC"},{"name":"Pakistan","abbreviation":"PK"},{"name":"Palau","abbreviation":"PW"},{"name":"Palestinian Territories","abbreviation":"PS"},{"name":"Panama","abbreviation":"PA"},{"name":"Panama Canal Zone","abbreviation":"PZ"},{"name":"Papua New Guinea","abbreviation":"PG"},{"name":"Paraguay","abbreviation":"PY"},{"name":"People's Democratic Republic of Yemen","abbreviation":"YD"},{"name":"Peru","abbreviation":"PE"},{"name":"Philippines","abbreviation":"PH"},{"name":"Pitcairn Islands","abbreviation":"PN"},{"name":"Poland","abbreviation":"PL"},{"name":"Portugal","abbreviation":"PT"},{"name":"Puerto Rico","abbreviation":"PR"},{"name":"Qatar","abbreviation":"QA"},{"name":"Romania","abbreviation":"RO"},{"name":"Russia","abbreviation":"RU"},{"name":"Rwanda","abbreviation":"RW"},{"name":"Réunion","abbreviation":"RE"},{"name":"Saint Barthélemy","abbreviation":"BL"},{"name":"Saint Helena","abbreviation":"SH"},{"name":"Saint Kitts and Nevis","abbreviation":"KN"},{"name":"Saint Lucia","abbreviation":"LC"},{"name":"Saint Martin","abbreviation":"MF"},{"name":"Saint Pierre and Miquelon","abbreviation":"PM"},{"name":"Saint Vincent and the Grenadines","abbreviation":"VC"},{"name":"Samoa","abbreviation":"WS"},{"name":"San Marino","abbreviation":"SM"},{"name":"Saudi Arabia","abbreviation":"SA"},{"name":"Senegal","abbreviation":"SN"},{"name":"Serbia","abbreviation":"RS"},{"name":"Serbia and Montenegro","abbreviation":"CS"},{"name":"Seychelles","abbreviation":"SC"},{"name":"Sierra Leone","abbreviation":"SL"},{"name":"Singapore","abbreviation":"SG"},{"name":"Slovakia","abbreviation":"SK"},{"name":"Slovenia","abbreviation":"SI"},{"name":"Solomon Islands","abbreviation":"SB"},{"name":"Somalia","abbreviation":"SO"},{"name":"South Africa","abbreviation":"ZA"},{"name":"South Georgia and the South Sandwich Islands","abbreviation":"GS"},{"name":"South Korea","abbreviation":"KR"},{"name":"Spain","abbreviation":"ES"},{"name":"Sri Lanka","abbreviation":"LK"},{"name":"Sudan","abbreviation":"SD"},{"name":"Suriname","abbreviation":"SR"},{"name":"Svalbard and Jan Mayen","abbreviation":"SJ"},{"name":"Swaziland","abbreviation":"SZ"},{"name":"Sweden","abbreviation":"SE"},{"name":"Switzerland","abbreviation":"CH"},{"name":"Syria","abbreviation":"SY"},{"name":"São Tomé and Príncipe","abbreviation":"ST"},{"name":"Taiwan","abbreviation":"TW"},{"name":"Tajikistan","abbreviation":"TJ"},{"name":"Tanzania","abbreviation":"TZ"},{"name":"Thailand","abbreviation":"TH"},{"name":"Timor-Leste","abbreviation":"TL"},{"name":"Togo","abbreviation":"TG"},{"name":"Tokelau","abbreviation":"TK"},{"name":"Tonga","abbreviation":"TO"},{"name":"Trinidad and Tobago","abbreviation":"TT"},{"name":"Tunisia","abbreviation":"TN"},{"name":"Turkey","abbreviation":"TR"},{"name":"Turkmenistan","abbreviation":"TM"},{"name":"Turks and Caicos Islands","abbreviation":"TC"},{"name":"Tuvalu","abbreviation":"TV"},{"name":"U.S. Minor Outlying Islands","abbreviation":"UM"},{"name":"U.S. Miscellaneous Pacific Islands","abbreviation":"PU"},{"name":"U.S. Virgin Islands","abbreviation":"VI"},{"name":"Uganda","abbreviation":"UG"},{"name":"Ukraine","abbreviation":"UA"},{"name":"Union of Soviet Socialist Republics","abbreviation":"SU"},{"name":"United Arab Emirates","abbreviation":"AE"},{"name":"United Kingdom","abbreviation":"GB"},{"name":"United States","abbreviation":"US"},{"name":"Unknown or Invalid Region","abbreviation":"ZZ"},{"name":"Uruguay","abbreviation":"UY"},{"name":"Uzbekistan","abbreviation":"UZ"},{"name":"Vanuatu","abbreviation":"VU"},{"name":"Vatican City","abbreviation":"VA"},{"name":"Venezuela","abbreviation":"VE"},{"name":"Vietnam","abbreviation":"VN"},{"name":"Wake Island","abbreviation":"WK"},{"name":"Wallis and Futuna","abbreviation":"WF"},{"name":"Western Sahara","abbreviation":"EH"},{"name":"Yemen","abbreviation":"YE"},{"name":"Zambia","abbreviation":"ZM"},{"name":"Zimbabwe","abbreviation":"ZW"},{"name":"Åland Islands","abbreviation":"AX"}],

        provinces: [
            {name: 'Alberta', abbreviation: 'AB'},
            {name: 'British Columbia', abbreviation: 'BC'},
            {name: 'Manitoba', abbreviation: 'MB'},
            {name: 'New Brunswick', abbreviation: 'NB'},
            {name: 'Newfoundland and Labrador', abbreviation: 'NL'},
            {name: 'Nova Scotia', abbreviation: 'NS'},
            {name: 'Ontario', abbreviation: 'ON'},
            {name: 'Prince Edward Island', abbreviation: 'PE'},
            {name: 'Quebec', abbreviation: 'QC'},
            {name: 'Saskatchewan', abbreviation: 'SK'},

            // The case could be made that the following are not actually provinces
            // since they are technically considered "territories" however they all
            // look the same on an envelope!
            {name: 'Northwest Territories', abbreviation: 'NT'},
            {name: 'Nunavut', abbreviation: 'NU'},
            {name: 'Yukon', abbreviation: 'YT'}
        ],

            // from: https://github.com/samsargent/Useful-Autocomplete-Data/blob/master/data/nationalities.json
        nationalities: [
           {name: 'Afghan'},
           {name: 'Albanian'},
           {name: 'Algerian'},
           {name: 'American'},
           {name: 'Andorran'},
           {name: 'Angolan'},
           {name: 'Antiguans'},
           {name: 'Argentinean'},
           {name: 'Armenian'},
           {name: 'Australian'},
           {name: 'Austrian'},
           {name: 'Azerbaijani'},
           {name: 'Bahami'},
           {name: 'Bahraini'},
           {name: 'Bangladeshi'},
           {name: 'Barbadian'},
           {name: 'Barbudans'},
           {name: 'Batswana'},
           {name: 'Belarusian'},
           {name: 'Belgian'},
           {name: 'Belizean'},
           {name: 'Beninese'},
           {name: 'Bhutanese'},
           {name: 'Bolivian'},
           {name: 'Bosnian'},
           {name: 'Brazilian'},
           {name: 'British'},
           {name: 'Bruneian'},
           {name: 'Bulgarian'},
           {name: 'Burkinabe'},
           {name: 'Burmese'},
           {name: 'Burundian'},
           {name: 'Cambodian'},
           {name: 'Cameroonian'},
           {name: 'Canadian'},
           {name: 'Cape Verdean'},
           {name: 'Central African'},
           {name: 'Chadian'},
           {name: 'Chilean'},
           {name: 'Chinese'},
           {name: 'Colombian'},
           {name: 'Comoran'},
           {name: 'Congolese'},
           {name: 'Costa Rican'},
           {name: 'Croatian'},
           {name: 'Cuban'},
           {name: 'Cypriot'},
           {name: 'Czech'},
           {name: 'Danish'},
           {name: 'Djibouti'},
           {name: 'Dominican'},
           {name: 'Dutch'},
           {name: 'East Timorese'},
           {name: 'Ecuadorean'},
           {name: 'Egyptian'},
           {name: 'Emirian'},
           {name: 'Equatorial Guinean'},
           {name: 'Eritrean'},
           {name: 'Estonian'},
           {name: 'Ethiopian'},
           {name: 'Fijian'},
           {name: 'Filipino'},
           {name: 'Finnish'},
           {name: 'French'},
           {name: 'Gabonese'},
           {name: 'Gambian'},
           {name: 'Georgian'},
           {name: 'German'},
           {name: 'Ghanaian'},
           {name: 'Greek'},
           {name: 'Grenadian'},
           {name: 'Guatemalan'},
           {name: 'Guinea-Bissauan'},
           {name: 'Guinean'},
           {name: 'Guyanese'},
           {name: 'Haitian'},
           {name: 'Herzegovinian'},
           {name: 'Honduran'},
           {name: 'Hungarian'},
           {name: 'I-Kiribati'},
           {name: 'Icelander'},
           {name: 'Indian'},
           {name: 'Indonesian'},
           {name: 'Iranian'},
           {name: 'Iraqi'},
           {name: 'Irish'},
           {name: 'Israeli'},
           {name: 'Italian'},
           {name: 'Ivorian'},
           {name: 'Jamaican'},
           {name: 'Japanese'},
           {name: 'Jordanian'},
           {name: 'Kazakhstani'},
           {name: 'Kenyan'},
           {name: 'Kittian and Nevisian'},
           {name: 'Kuwaiti'},
           {name: 'Kyrgyz'},
           {name: 'Laotian'},
           {name: 'Latvian'},
           {name: 'Lebanese'},
           {name: 'Liberian'},
           {name: 'Libyan'},
           {name: 'Liechtensteiner'},
           {name: 'Lithuanian'},
           {name: 'Luxembourger'},
           {name: 'Macedonian'},
           {name: 'Malagasy'},
           {name: 'Malawian'},
           {name: 'Malaysian'},
           {name: 'Maldivan'},
           {name: 'Malian'},
           {name: 'Maltese'},
           {name: 'Marshallese'},
           {name: 'Mauritanian'},
           {name: 'Mauritian'},
           {name: 'Mexican'},
           {name: 'Micronesian'},
           {name: 'Moldovan'},
           {name: 'Monacan'},
           {name: 'Mongolian'},
           {name: 'Moroccan'},
           {name: 'Mosotho'},
           {name: 'Motswana'},
           {name: 'Mozambican'},
           {name: 'Namibian'},
           {name: 'Nauruan'},
           {name: 'Nepalese'},
           {name: 'New Zealander'},
           {name: 'Nicaraguan'},
           {name: 'Nigerian'},
           {name: 'Nigerien'},
           {name: 'North Korean'},
           {name: 'Northern Irish'},
           {name: 'Norwegian'},
           {name: 'Omani'},
           {name: 'Pakistani'},
           {name: 'Palauan'},
           {name: 'Panamanian'},
           {name: 'Papua New Guinean'},
           {name: 'Paraguayan'},
           {name: 'Peruvian'},
           {name: 'Polish'},
           {name: 'Portuguese'},
           {name: 'Qatari'},
           {name: 'Romani'},          
           {name: 'Russian'},
           {name: 'Rwandan'},
           {name: 'Saint Lucian'},
           {name: 'Salvadoran'},
           {name: 'Samoan'},
           {name: 'San Marinese'},
           {name: 'Sao Tomean'},
           {name: 'Saudi'},
           {name: 'Scottish'},
           {name: 'Senegalese'},
           {name: 'Serbian'},
           {name: 'Seychellois'},
           {name: 'Sierra Leonean'},
           {name: 'Singaporean'},
           {name: 'Slovakian'},
           {name: 'Slovenian'},
           {name: 'Solomon Islander'},
           {name: 'Somali'},
           {name: 'South African'},
           {name: 'South Korean'},
           {name: 'Spanish'},
           {name: 'Sri Lankan'},
           {name: 'Sudanese'},
           {name: 'Surinamer'},
           {name: 'Swazi'},
           {name: 'Swedish'},
           {name: 'Swiss'},
           {name: 'Syrian'},
           {name: 'Taiwanese'},
           {name: 'Tajik'},
           {name: 'Tanzanian'},
           {name: 'Thai'},
           {name: 'Togolese'},
           {name: 'Tongan'},
           {name: 'Trinidadian or Tobagonian'},
           {name: 'Tunisian'},
           {name: 'Turkish'},
           {name: 'Tuvaluan'},
           {name: 'Ugandan'},
           {name: 'Ukrainian'},
           {name: 'Uruguaya'},
           {name: 'Uzbekistani'},
           {name: 'Venezuela'},
           {name: 'Vietnamese'},
           {name: 'Wels'},
           {name: 'Yemenit'},
           {name: 'Zambia'},
           {name: 'Zimbabwe'},
        ],

        us_states_and_dc: [
            {name: 'Alabama', abbreviation: 'AL'},
            {name: 'Alaska', abbreviation: 'AK'},
            {name: 'Arizona', abbreviation: 'AZ'},
            {name: 'Arkansas', abbreviation: 'AR'},
            {name: 'California', abbreviation: 'CA'},
            {name: 'Colorado', abbreviation: 'CO'},
            {name: 'Connecticut', abbreviation: 'CT'},
            {name: 'Delaware', abbreviation: 'DE'},
            {name: 'District of Columbia', abbreviation: 'DC'},
            {name: 'Florida', abbreviation: 'FL'},
            {name: 'Georgia', abbreviation: 'GA'},
            {name: 'Hawaii', abbreviation: 'HI'},
            {name: 'Idaho', abbreviation: 'ID'},
            {name: 'Illinois', abbreviation: 'IL'},
            {name: 'Indiana', abbreviation: 'IN'},
            {name: 'Iowa', abbreviation: 'IA'},
            {name: 'Kansas', abbreviation: 'KS'},
            {name: 'Kentucky', abbreviation: 'KY'},
            {name: 'Louisiana', abbreviation: 'LA'},
            {name: 'Maine', abbreviation: 'ME'},
            {name: 'Maryland', abbreviation: 'MD'},
            {name: 'Massachusetts', abbreviation: 'MA'},
            {name: 'Michigan', abbreviation: 'MI'},
            {name: 'Minnesota', abbreviation: 'MN'},
            {name: 'Mississippi', abbreviation: 'MS'},
            {name: 'Missouri', abbreviation: 'MO'},
            {name: 'Montana', abbreviation: 'MT'},
            {name: 'Nebraska', abbreviation: 'NE'},
            {name: 'Nevada', abbreviation: 'NV'},
            {name: 'New Hampshire', abbreviation: 'NH'},
            {name: 'New Jersey', abbreviation: 'NJ'},
            {name: 'New Mexico', abbreviation: 'NM'},
            {name: 'New York', abbreviation: 'NY'},
            {name: 'North Carolina', abbreviation: 'NC'},
            {name: 'North Dakota', abbreviation: 'ND'},
            {name: 'Ohio', abbreviation: 'OH'},
            {name: 'Oklahoma', abbreviation: 'OK'},
            {name: 'Oregon', abbreviation: 'OR'},
            {name: 'Pennsylvania', abbreviation: 'PA'},
            {name: 'Rhode Island', abbreviation: 'RI'},
            {name: 'South Carolina', abbreviation: 'SC'},
            {name: 'South Dakota', abbreviation: 'SD'},
            {name: 'Tennessee', abbreviation: 'TN'},
            {name: 'Texas', abbreviation: 'TX'},
            {name: 'Utah', abbreviation: 'UT'},
            {name: 'Vermont', abbreviation: 'VT'},
            {name: 'Virginia', abbreviation: 'VA'},
            {name: 'Washington', abbreviation: 'WA'},
            {name: 'West Virginia', abbreviation: 'WV'},
            {name: 'Wisconsin', abbreviation: 'WI'},
            {name: 'Wyoming', abbreviation: 'WY'}
        ],

        territories: [
            {name: 'American Samoa', abbreviation: 'AS'},
            {name: 'Federated States of Micronesia', abbreviation: 'FM'},
            {name: 'Guam', abbreviation: 'GU'},
            {name: 'Marshall Islands', abbreviation: 'MH'},
            {name: 'Northern Mariana Islands', abbreviation: 'MP'},
            {name: 'Puerto Rico', abbreviation: 'PR'},
            {name: 'Virgin Islands, U.S.', abbreviation: 'VI'}
        ],

        armed_forces: [
            {name: 'Armed Forces Europe', abbreviation: 'AE'},
            {name: 'Armed Forces Pacific', abbreviation: 'AP'},
            {name: 'Armed Forces the Americas', abbreviation: 'AA'}
        ],

        street_suffixes: [
            {name: 'Avenue', abbreviation: 'Ave'},
            {name: 'Boulevard', abbreviation: 'Blvd'},
            {name: 'Center', abbreviation: 'Ctr'},
            {name: 'Circle', abbreviation: 'Cir'},
            {name: 'Court', abbreviation: 'Ct'},
            {name: 'Drive', abbreviation: 'Dr'},
            {name: 'Extension', abbreviation: 'Ext'},
            {name: 'Glen', abbreviation: 'Gln'},
            {name: 'Grove', abbreviation: 'Grv'},
            {name: 'Heights', abbreviation: 'Hts'},
            {name: 'Highway', abbreviation: 'Hwy'},
            {name: 'Junction', abbreviation: 'Jct'},
            {name: 'Key', abbreviation: 'Key'},
            {name: 'Lane', abbreviation: 'Ln'},
            {name: 'Loop', abbreviation: 'Loop'},
            {name: 'Manor', abbreviation: 'Mnr'},
            {name: 'Mill', abbreviation: 'Mill'},
            {name: 'Park', abbreviation: 'Park'},
            {name: 'Parkway', abbreviation: 'Pkwy'},
            {name: 'Pass', abbreviation: 'Pass'},
            {name: 'Path', abbreviation: 'Path'},
            {name: 'Pike', abbreviation: 'Pike'},
            {name: 'Place', abbreviation: 'Pl'},
            {name: 'Plaza', abbreviation: 'Plz'},
            {name: 'Point', abbreviation: 'Pt'},
            {name: 'Ridge', abbreviation: 'Rdg'},
            {name: 'River', abbreviation: 'Riv'},
            {name: 'Road', abbreviation: 'Rd'},
            {name: 'Square', abbreviation: 'Sq'},
            {name: 'Street', abbreviation: 'St'},
            {name: 'Terrace', abbreviation: 'Ter'},
            {name: 'Trail', abbreviation: 'Trl'},
            {name: 'Turnpike', abbreviation: 'Tpke'},
            {name: 'View', abbreviation: 'Vw'},
            {name: 'Way', abbreviation: 'Way'}
        ],

        months: [
            {name: 'January', short_name: 'Jan', numeric: '01', days: 31},
            // Not messing with leap years...
            {name: 'February', short_name: 'Feb', numeric: '02', days: 28},
            {name: 'March', short_name: 'Mar', numeric: '03', days: 31},
            {name: 'April', short_name: 'Apr', numeric: '04', days: 30},
            {name: 'May', short_name: 'May', numeric: '05', days: 31},
            {name: 'June', short_name: 'Jun', numeric: '06', days: 30},
            {name: 'July', short_name: 'Jul', numeric: '07', days: 31},
            {name: 'August', short_name: 'Aug', numeric: '08', days: 31},
            {name: 'September', short_name: 'Sep', numeric: '09', days: 30},
            {name: 'October', short_name: 'Oct', numeric: '10', days: 31},
            {name: 'November', short_name: 'Nov', numeric: '11', days: 30},
            {name: 'December', short_name: 'Dec', numeric: '12', days: 31}
        ],

        // http://en.wikipedia.org/wiki/Bank_card_number#Issuer_identification_number_.28IIN.29
        cc_types: [
            {name: "American Express", short_name: 'amex', prefix: '34', length: 15},
            {name: "Bankcard", short_name: 'bankcard', prefix: '5610', length: 16},
            {name: "China UnionPay", short_name: 'chinaunion', prefix: '62', length: 16},
            {name: "Diners Club Carte Blanche", short_name: 'dccarte', prefix: '300', length: 14},
            {name: "Diners Club enRoute", short_name: 'dcenroute', prefix: '2014', length: 15},
            {name: "Diners Club International", short_name: 'dcintl', prefix: '36', length: 14},
            {name: "Diners Club United States & Canada", short_name: 'dcusc', prefix: '54', length: 16},
            {name: "Discover Card", short_name: 'discover', prefix: '6011', length: 16},
            {name: "InstaPayment", short_name: 'instapay', prefix: '637', length: 16},
            {name: "JCB", short_name: 'jcb', prefix: '3528', length: 16},
            {name: "Laser", short_name: 'laser', prefix: '6304', length: 16},
            {name: "Maestro", short_name: 'maestro', prefix: '5018', length: 16},
            {name: "Mastercard", short_name: 'mc', prefix: '51', length: 16},
            {name: "Solo", short_name: 'solo', prefix: '6334', length: 16},
            {name: "Switch", short_name: 'switch', prefix: '4903', length: 16},
            {name: "Visa", short_name: 'visa', prefix: '4', length: 16},
            {name: "Visa Electron", short_name: 'electron', prefix: '4026', length: 16}
        ],

        //return all world currency by ISO 4217
        currency_types: [
            {'code' : 'AED', 'name' : 'United Arab Emirates Dirham'},
            {'code' : 'AFN', 'name' : 'Afghanistan Afghani'},
            {'code' : 'ALL', 'name' : 'Albania Lek'},
            {'code' : 'AMD', 'name' : 'Armenia Dram'},
            {'code' : 'ANG', 'name' : 'Netherlands Antilles Guilder'},
            {'code' : 'AOA', 'name' : 'Angola Kwanza'},
            {'code' : 'ARS', 'name' : 'Argentina Peso'},
            {'code' : 'AUD', 'name' : 'Australia Dollar'},
            {'code' : 'AWG', 'name' : 'Aruba Guilder'},
            {'code' : 'AZN', 'name' : 'Azerbaijan New Manat'},
            {'code' : 'BAM', 'name' : 'Bosnia and Herzegovina Convertible Marka'},
            {'code' : 'BBD', 'name' : 'Barbados Dollar'},
            {'code' : 'BDT', 'name' : 'Bangladesh Taka'},
            {'code' : 'BGN', 'name' : 'Bulgaria Lev'},
            {'code' : 'BHD', 'name' : 'Bahrain Dinar'},
            {'code' : 'BIF', 'name' : 'Burundi Franc'},
            {'code' : 'BMD', 'name' : 'Bermuda Dollar'},
            {'code' : 'BND', 'name' : 'Brunei Darussalam Dollar'},
            {'code' : 'BOB', 'name' : 'Bolivia Boliviano'},
            {'code' : 'BRL', 'name' : 'Brazil Real'},
            {'code' : 'BSD', 'name' : 'Bahamas Dollar'},
            {'code' : 'BTN', 'name' : 'Bhutan Ngultrum'},
            {'code' : 'BWP', 'name' : 'Botswana Pula'},
            {'code' : 'BYR', 'name' : 'Belarus Ruble'},
            {'code' : 'BZD', 'name' : 'Belize Dollar'},
            {'code' : 'CAD', 'name' : 'Canada Dollar'},
            {'code' : 'CDF', 'name' : 'Congo/Kinshasa Franc'},
            {'code' : 'CHF', 'name' : 'Switzerland Franc'},
            {'code' : 'CLP', 'name' : 'Chile Peso'},
            {'code' : 'CNY', 'name' : 'China Yuan Renminbi'},
            {'code' : 'COP', 'name' : 'Colombia Peso'},
            {'code' : 'CRC', 'name' : 'Costa Rica Colon'},
            {'code' : 'CUC', 'name' : 'Cuba Convertible Peso'},
            {'code' : 'CUP', 'name' : 'Cuba Peso'},
            {'code' : 'CVE', 'name' : 'Cape Verde Escudo'},
            {'code' : 'CZK', 'name' : 'Czech Republic Koruna'},
            {'code' : 'DJF', 'name' : 'Djibouti Franc'},
            {'code' : 'DKK', 'name' : 'Denmark Krone'},
            {'code' : 'DOP', 'name' : 'Dominican Republic Peso'},
            {'code' : 'DZD', 'name' : 'Algeria Dinar'},
            {'code' : 'EGP', 'name' : 'Egypt Pound'},
            {'code' : 'ERN', 'name' : 'Eritrea Nakfa'},
            {'code' : 'ETB', 'name' : 'Ethiopia Birr'},
            {'code' : 'EUR', 'name' : 'Euro Member Countries'},
            {'code' : 'FJD', 'name' : 'Fiji Dollar'},
            {'code' : 'FKP', 'name' : 'Falkland Islands (Malvinas) Pound'},
            {'code' : 'GBP', 'name' : 'United Kingdom Pound'},
            {'code' : 'GEL', 'name' : 'Georgia Lari'},
            {'code' : 'GGP', 'name' : 'Guernsey Pound'},
            {'code' : 'GHS', 'name' : 'Ghana Cedi'},
            {'code' : 'GIP', 'name' : 'Gibraltar Pound'},
            {'code' : 'GMD', 'name' : 'Gambia Dalasi'},
            {'code' : 'GNF', 'name' : 'Guinea Franc'},
            {'code' : 'GTQ', 'name' : 'Guatemala Quetzal'},
            {'code' : 'GYD', 'name' : 'Guyana Dollar'},
            {'code' : 'HKD', 'name' : 'Hong Kong Dollar'},
            {'code' : 'HNL', 'name' : 'Honduras Lempira'},
            {'code' : 'HRK', 'name' : 'Croatia Kuna'},
            {'code' : 'HTG', 'name' : 'Haiti Gourde'},
            {'code' : 'HUF', 'name' : 'Hungary Forint'},
            {'code' : 'IDR', 'name' : 'Indonesia Rupiah'},
            {'code' : 'ILS', 'name' : 'Israel Shekel'},
            {'code' : 'IMP', 'name' : 'Isle of Man Pound'},
            {'code' : 'INR', 'name' : 'India Rupee'},
            {'code' : 'IQD', 'name' : 'Iraq Dinar'},
            {'code' : 'IRR', 'name' : 'Iran Rial'},
            {'code' : 'ISK', 'name' : 'Iceland Krona'},
            {'code' : 'JEP', 'name' : 'Jersey Pound'},
            {'code' : 'JMD', 'name' : 'Jamaica Dollar'},
            {'code' : 'JOD', 'name' : 'Jordan Dinar'},
            {'code' : 'JPY', 'name' : 'Japan Yen'},
            {'code' : 'KES', 'name' : 'Kenya Shilling'},
            {'code' : 'KGS', 'name' : 'Kyrgyzstan Som'},
            {'code' : 'KHR', 'name' : 'Cambodia Riel'},
            {'code' : 'KMF', 'name' : 'Comoros Franc'},
            {'code' : 'KPW', 'name' : 'Korea (North) Won'},
            {'code' : 'KRW', 'name' : 'Korea (South) Won'},
            {'code' : 'KWD', 'name' : 'Kuwait Dinar'},
            {'code' : 'KYD', 'name' : 'Cayman Islands Dollar'},
            {'code' : 'KZT', 'name' : 'Kazakhstan Tenge'},
            {'code' : 'LAK', 'name' : 'Laos Kip'},
            {'code' : 'LBP', 'name' : 'Lebanon Pound'},
            {'code' : 'LKR', 'name' : 'Sri Lanka Rupee'},
            {'code' : 'LRD', 'name' : 'Liberia Dollar'},
            {'code' : 'LSL', 'name' : 'Lesotho Loti'},
            {'code' : 'LTL', 'name' : 'Lithuania Litas'},
            {'code' : 'LYD', 'name' : 'Libya Dinar'},
            {'code' : 'MAD', 'name' : 'Morocco Dirham'},
            {'code' : 'MDL', 'name' : 'Moldova Leu'},
            {'code' : 'MGA', 'name' : 'Madagascar Ariary'},
            {'code' : 'MKD', 'name' : 'Macedonia Denar'},
            {'code' : 'MMK', 'name' : 'Myanmar (Burma) Kyat'},
            {'code' : 'MNT', 'name' : 'Mongolia Tughrik'},
            {'code' : 'MOP', 'name' : 'Macau Pataca'},
            {'code' : 'MRO', 'name' : 'Mauritania Ouguiya'},
            {'code' : 'MUR', 'name' : 'Mauritius Rupee'},
            {'code' : 'MVR', 'name' : 'Maldives (Maldive Islands) Rufiyaa'},
            {'code' : 'MWK', 'name' : 'Malawi Kwacha'},
            {'code' : 'MXN', 'name' : 'Mexico Peso'},
            {'code' : 'MYR', 'name' : 'Malaysia Ringgit'},
            {'code' : 'MZN', 'name' : 'Mozambique Metical'},
            {'code' : 'NAD', 'name' : 'Namibia Dollar'},
            {'code' : 'NGN', 'name' : 'Nigeria Naira'},
            {'code' : 'NIO', 'name' : 'Nicaragua Cordoba'},
            {'code' : 'NOK', 'name' : 'Norway Krone'},
            {'code' : 'NPR', 'name' : 'Nepal Rupee'},
            {'code' : 'NZD', 'name' : 'New Zealand Dollar'},
            {'code' : 'OMR', 'name' : 'Oman Rial'},
            {'code' : 'PAB', 'name' : 'Panama Balboa'},
            {'code' : 'PEN', 'name' : 'Peru Nuevo Sol'},
            {'code' : 'PGK', 'name' : 'Papua New Guinea Kina'},
            {'code' : 'PHP', 'name' : 'Philippines Peso'},
            {'code' : 'PKR', 'name' : 'Pakistan Rupee'},
            {'code' : 'PLN', 'name' : 'Poland Zloty'},
            {'code' : 'PYG', 'name' : 'Paraguay Guarani'},
            {'code' : 'QAR', 'name' : 'Qatar Riyal'},
            {'code' : 'RON', 'name' : 'Romania New Leu'},
            {'code' : 'RSD', 'name' : 'Serbia Dinar'},
            {'code' : 'RUB', 'name' : 'Russia Ruble'},
            {'code' : 'RWF', 'name' : 'Rwanda Franc'},
            {'code' : 'SAR', 'name' : 'Saudi Arabia Riyal'},
            {'code' : 'SBD', 'name' : 'Solomon Islands Dollar'},
            {'code' : 'SCR', 'name' : 'Seychelles Rupee'},
            {'code' : 'SDG', 'name' : 'Sudan Pound'},
            {'code' : 'SEK', 'name' : 'Sweden Krona'},
            {'code' : 'SGD', 'name' : 'Singapore Dollar'},
            {'code' : 'SHP', 'name' : 'Saint Helena Pound'},
            {'code' : 'SLL', 'name' : 'Sierra Leone Leone'},
            {'code' : 'SOS', 'name' : 'Somalia Shilling'},
            {'code' : 'SPL', 'name' : 'Seborga Luigino'},
            {'code' : 'SRD', 'name' : 'Suriname Dollar'},
            {'code' : 'STD', 'name' : 'São Tomé and Príncipe Dobra'},
            {'code' : 'SVC', 'name' : 'El Salvador Colon'},
            {'code' : 'SYP', 'name' : 'Syria Pound'},
            {'code' : 'SZL', 'name' : 'Swaziland Lilangeni'},
            {'code' : 'THB', 'name' : 'Thailand Baht'},
            {'code' : 'TJS', 'name' : 'Tajikistan Somoni'},
            {'code' : 'TMT', 'name' : 'Turkmenistan Manat'},
            {'code' : 'TND', 'name' : 'Tunisia Dinar'},
            {'code' : 'TOP', 'name' : 'Tonga Pa\'anga'},
            {'code' : 'TRY', 'name' : 'Turkey Lira'},
            {'code' : 'TTD', 'name' : 'Trinidad and Tobago Dollar'},
            {'code' : 'TVD', 'name' : 'Tuvalu Dollar'},
            {'code' : 'TWD', 'name' : 'Taiwan New Dollar'},
            {'code' : 'TZS', 'name' : 'Tanzania Shilling'},
            {'code' : 'UAH', 'name' : 'Ukraine Hryvnia'},
            {'code' : 'UGX', 'name' : 'Uganda Shilling'},
            {'code' : 'USD', 'name' : 'United States Dollar'},
            {'code' : 'UYU', 'name' : 'Uruguay Peso'},
            {'code' : 'UZS', 'name' : 'Uzbekistan Som'},
            {'code' : 'VEF', 'name' : 'Venezuela Bolivar'},
            {'code' : 'VND', 'name' : 'Viet Nam Dong'},
            {'code' : 'VUV', 'name' : 'Vanuatu Vatu'},
            {'code' : 'WST', 'name' : 'Samoa Tala'},
            {'code' : 'XAF', 'name' : 'Communauté Financière Africaine (BEAC) CFA Franc BEAC'},
            {'code' : 'XCD', 'name' : 'East Caribbean Dollar'},
            {'code' : 'XDR', 'name' : 'International Monetary Fund (IMF) Special Drawing Rights'},
            {'code' : 'XOF', 'name' : 'Communauté Financière Africaine (BCEAO) Franc'},
            {'code' : 'XPF', 'name' : 'Comptoirs Français du Pacifique (CFP) Franc'},
            {'code' : 'YER', 'name' : 'Yemen Rial'},
            {'code' : 'ZAR', 'name' : 'South Africa Rand'},
            {'code' : 'ZMW', 'name' : 'Zambia Kwacha'},
            {'code' : 'ZWD', 'name' : 'Zimbabwe Dollar'}
        ],
        
        // return the names of all valide colors
        colorNames : [  "AliceBlue", "Black", "Navy", "DarkBlue", "MediumBlue", "Blue", "DarkGreen", "Green", "Teal", "DarkCyan", "DeepSkyBlue", "DarkTurquoise", "MediumSpringGreen", "Lime", "SpringGreen",
            "Aqua", "Cyan", "MidnightBlue", "DodgerBlue", "LightSeaGreen", "ForestGreen", "SeaGreen", "DarkSlateGray", "LimeGreen", "MediumSeaGreen", "Turquoise", "RoyalBlue", "SteelBlue", "DarkSlateBlue", "MediumTurquoise",
            "Indigo", "DarkOliveGreen", "CadetBlue", "CornflowerBlue", "RebeccaPurple", "MediumAquaMarine", "DimGray", "SlateBlue", "OliveDrab", "SlateGray", "LightSlateGray", "MediumSlateBlue", "LawnGreen", "Chartreuse",
            "Aquamarine", "Maroon", "Purple", "Olive", "Gray", "SkyBlue", "LightSkyBlue", "BlueViolet", "DarkRed", "DarkMagenta", "SaddleBrown", "Ivory", "White",
            "DarkSeaGreen", "LightGreen", "MediumPurple", "DarkViolet", "PaleGreen", "DarkOrchid", "YellowGreen", "Sienna", "Brown", "DarkGray", "LightBlue", "GreenYellow", "PaleTurquoise", "LightSteelBlue", "PowderBlue",
            "FireBrick", "DarkGoldenRod", "MediumOrchid", "RosyBrown", "DarkKhaki", "Silver", "MediumVioletRed", "IndianRed", "Peru", "Chocolate", "Tan", "LightGray", "Thistle", "Orchid", "GoldenRod", "PaleVioletRed",
            "Crimson", "Gainsboro", "Plum", "BurlyWood", "LightCyan", "Lavender", "DarkSalmon", "Violet", "PaleGoldenRod", "LightCoral", "Khaki", "AliceBlue", "HoneyDew", "Azure", "SandyBrown", "Wheat", "Beige", "WhiteSmoke",
            "MintCream", "GhostWhite", "Salmon", "AntiqueWhite", "Linen", "LightGoldenRodYellow", "OldLace", "Red", "Fuchsia", "Magenta", "DeepPink", "OrangeRed", "Tomato", "HotPink", "Coral", "DarkOrange", "LightSalmon", "Orange",
            "LightPink", "Pink", "Gold", "PeachPuff", "NavajoWhite", "Moccasin", "Bisque", "MistyRose", "BlanchedAlmond", "PapayaWhip", "LavenderBlush", "SeaShell", "Cornsilk", "LemonChiffon", "FloralWhite", "Snow", "Yellow", "LightYellow"
        ],        

        fileExtension : {
            "raster"    : ["bmp", "gif", "gpl", "ico", "jpeg", "psd", "png", "psp", "raw", "tiff"],
            "vector"    : ["3dv", "amf", "awg", "ai", "cgm", "cdr", "cmx", "dxf", "e2d", "egt", "eps", "fs", "odg", "svg", "xar"],
            "3d"        : ["3dmf", "3dm", "3mf", "3ds", "an8", "aoi", "blend", "cal3d", "cob", "ctm", "iob", "jas", "max", "mb", "mdx", "obj", "x", "x3d"],
            "document"  : ["doc", "docx", "dot", "html", "xml", "odt", "odm", "ott", "csv", "rtf", "tex", "xhtml", "xps"]
        }
    };

    var o_hasOwnProperty = Object.prototype.hasOwnProperty;
    var o_keys = (Object.keys || function(obj) {
      var result = [];
      for (var key in obj) {
        if (o_hasOwnProperty.call(obj, key)) {
          result.push(key);
        }
      }

      return result;
    });

    function _copyObject(source, target) {
      var keys = o_keys(source);
      var key;

      for (var i = 0, l = keys.length; i < l; i++) {
        key = keys[i];
        target[key] = source[key] || target[key];
      }
    }

    function _copyArray(source, target) {
      for (var i = 0, l = source.length; i < l; i++) {
        target[i] = source[i];
      }
    }

    function copyObject(source, _target) {
        var isArray = Array.isArray(source);
        var target = _target || (isArray ? new Array(source.length) : {});

        if (isArray) {
          _copyArray(source, target);
        } else {
          _copyObject(source, target);
        }

        return target;
    }

    /** Get the data based on key**/
    Chance.prototype.get = function (name) {
        return copyObject(data[name]);
    };

    // Mac Address
    Chance.prototype.mac_address = function(options){
        // typically mac addresses are separated by ":"
        // however they can also be separated by "-"
        // the network variant uses a dot every fourth byte

        options = initOptions(options);
        if(!options.separator) {
            options.separator =  options.networkVersion ? "." : ":";
        }

        var mac_pool="ABCDEF1234567890",
            mac = "";
        if(!options.networkVersion) {
            mac = this.n(this.string, 6, { pool: mac_pool, length:2 }).join(options.separator);
        } else {
            mac = this.n(this.string, 3, { pool: mac_pool, length:4 }).join(options.separator);
        }

        return mac;
    };

    Chance.prototype.normal = function (options) {
        options = initOptions(options, {mean : 0, dev : 1, pool : []});

        testRange(
            options.pool.constructor !== Array,
            "Chance: The pool option must be a valid array."
        );

        // If a pool has been passed, then we are returning an item from that pool,
        // using the normal distribution settings that were passed in
        if (options.pool.length > 0) {
            return this.normal_pool(options);
        }

        // The Marsaglia Polar method
        var s, u, v, norm,
            mean = options.mean,
            dev = options.dev;

        do {
            // U and V are from the uniform distribution on (-1, 1)
            u = this.random() * 2 - 1;
            v = this.random() * 2 - 1;

            s = u * u + v * v;
        } while (s >= 1);

        // Compute the standard normal variate
        norm = u * Math.sqrt(-2 * Math.log(s) / s);

        // Shape and scale
        return dev * norm + mean;
    };

    Chance.prototype.normal_pool = function(options) {
        var performanceCounter = 0;
        do {
            var idx = Math.round(this.normal({ mean: options.mean, dev: options.dev }));
            if (idx < options.pool.length && idx >= 0) {
                return options.pool[idx];
            } else {
                performanceCounter++;
            }
        } while(performanceCounter < 100);

        throw new RangeError("Chance: Your pool is too small for the given mean and standard deviation. Please adjust.");
    };

    Chance.prototype.radio = function (options) {
        // Initial Letter (Typically Designated by Side of Mississippi River)
        options = initOptions(options, {side : "?"});
        var fl = "";
        switch (options.side.toLowerCase()) {
        case "east":
        case "e":
            fl = "W";
            break;
        case "west":
        case "w":
            fl = "K";
            break;
        default:
            fl = this.character({pool: "KW"});
            break;
        }

        return fl + this.character({alpha: true, casing: "upper"}) +
                this.character({alpha: true, casing: "upper"}) +
                this.character({alpha: true, casing: "upper"});
    };

    // Set the data as key and data or the data map
    Chance.prototype.set = function (name, values) {
        if (typeof name === "string") {
            data[name] = values;
        } else {
            data = copyObject(name, data);
        }
    };

    Chance.prototype.tv = function (options) {
        return this.radio(options);
    };

    // ID number for Brazil companies
    Chance.prototype.cnpj = function () {
        var n = this.n(this.natural, 8, { max: 9 });
        var d1 = 2+n[7]*6+n[6]*7+n[5]*8+n[4]*9+n[3]*2+n[2]*3+n[1]*4+n[0]*5;
        d1 = 11 - (d1 % 11);
        if (d1>=10){
            d1 = 0;
        }
        var d2 = d1*2+3+n[7]*7+n[6]*8+n[5]*9+n[4]*2+n[3]*3+n[2]*4+n[1]*5+n[0]*6;
        d2 = 11 - (d2 % 11);
        if (d2>=10){
            d2 = 0;
        }
        return ''+n[0]+n[1]+'.'+n[2]+n[3]+n[4]+'.'+n[5]+n[6]+n[7]+'/0001-'+d1+d2;
    };

    // -- End Miscellaneous --

    Chance.prototype.mersenne_twister = function (seed) {
        return new MersenneTwister(seed);
    };

    Chance.prototype.blueimp_md5 = function () {
        return new BlueImpMD5();
    };

    // Mersenne Twister from https://gist.github.com/banksean/300494
    var MersenneTwister = function (seed) {
        if (seed === undefined) {
            // kept random number same size as time used previously to ensure no unexpected results downstream
            seed = Math.floor(Math.random()*Math.pow(10,13));
        }
        /* Period parameters */
        this.N = 624;
        this.M = 397;
        this.MATRIX_A = 0x9908b0df;   /* constant vector a */
        this.UPPER_MASK = 0x80000000; /* most significant w-r bits */
        this.LOWER_MASK = 0x7fffffff; /* least significant r bits */

        this.mt = new Array(this.N); /* the array for the state vector */
        this.mti = this.N + 1; /* mti==N + 1 means mt[N] is not initialized */

        this.init_genrand(seed);
    };

    /* initializes mt[N] with a seed */
    MersenneTwister.prototype.init_genrand = function (s) {
        this.mt[0] = s >>> 0;
        for (this.mti = 1; this.mti < this.N; this.mti++) {
            s = this.mt[this.mti - 1] ^ (this.mt[this.mti - 1] >>> 30);
            this.mt[this.mti] = (((((s & 0xffff0000) >>> 16) * 1812433253) << 16) + (s & 0x0000ffff) * 1812433253) + this.mti;
            /* See Knuth TAOCP Vol2. 3rd Ed. P.106 for multiplier. */
            /* In the previous versions, MSBs of the seed affect   */
            /* only MSBs of the array mt[].                        */
            /* 2002/01/09 modified by Makoto Matsumoto             */
            this.mt[this.mti] >>>= 0;
            /* for >32 bit machines */
        }
    };

    /* initialize by an array with array-length */
    /* init_key is the array for initializing keys */
    /* key_length is its length */
    /* slight change for C++, 2004/2/26 */
    MersenneTwister.prototype.init_by_array = function (init_key, key_length) {
        var i = 1, j = 0, k, s;
        this.init_genrand(19650218);
        k = (this.N > key_length ? this.N : key_length);
        for (; k; k--) {
            s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
            this.mt[i] = (this.mt[i] ^ (((((s & 0xffff0000) >>> 16) * 1664525) << 16) + ((s & 0x0000ffff) * 1664525))) + init_key[j] + j; /* non linear */
            this.mt[i] >>>= 0; /* for WORDSIZE > 32 machines */
            i++;
            j++;
            if (i >= this.N) { this.mt[0] = this.mt[this.N - 1]; i = 1; }
            if (j >= key_length) { j = 0; }
        }
        for (k = this.N - 1; k; k--) {
            s = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
            this.mt[i] = (this.mt[i] ^ (((((s & 0xffff0000) >>> 16) * 1566083941) << 16) + (s & 0x0000ffff) * 1566083941)) - i; /* non linear */
            this.mt[i] >>>= 0; /* for WORDSIZE > 32 machines */
            i++;
            if (i >= this.N) { this.mt[0] = this.mt[this.N - 1]; i = 1; }
        }

        this.mt[0] = 0x80000000; /* MSB is 1; assuring non-zero initial array */
    };

    /* generates a random number on [0,0xffffffff]-interval */
    MersenneTwister.prototype.genrand_int32 = function () {
        var y;
        var mag01 = new Array(0x0, this.MATRIX_A);
        /* mag01[x] = x * MATRIX_A  for x=0,1 */

        if (this.mti >= this.N) { /* generate N words at one time */
            var kk;

            if (this.mti === this.N + 1) {   /* if init_genrand() has not been called, */
                this.init_genrand(5489); /* a default initial seed is used */
            }
            for (kk = 0; kk < this.N - this.M; kk++) {
                y = (this.mt[kk]&this.UPPER_MASK)|(this.mt[kk + 1]&this.LOWER_MASK);
                this.mt[kk] = this.mt[kk + this.M] ^ (y >>> 1) ^ mag01[y & 0x1];
            }
            for (;kk < this.N - 1; kk++) {
                y = (this.mt[kk]&this.UPPER_MASK)|(this.mt[kk + 1]&this.LOWER_MASK);
                this.mt[kk] = this.mt[kk + (this.M - this.N)] ^ (y >>> 1) ^ mag01[y & 0x1];
            }
            y = (this.mt[this.N - 1]&this.UPPER_MASK)|(this.mt[0]&this.LOWER_MASK);
            this.mt[this.N - 1] = this.mt[this.M - 1] ^ (y >>> 1) ^ mag01[y & 0x1];

            this.mti = 0;
        }

        y = this.mt[this.mti++];

        /* Tempering */
        y ^= (y >>> 11);
        y ^= (y << 7) & 0x9d2c5680;
        y ^= (y << 15) & 0xefc60000;
        y ^= (y >>> 18);

        return y >>> 0;
    };

    /* generates a random number on [0,0x7fffffff]-interval */
    MersenneTwister.prototype.genrand_int31 = function () {
        return (this.genrand_int32() >>> 1);
    };

    /* generates a random number on [0,1]-real-interval */
    MersenneTwister.prototype.genrand_real1 = function () {
        return this.genrand_int32() * (1.0 / 4294967295.0);
        /* divided by 2^32-1 */
    };

    /* generates a random number on [0,1)-real-interval */
    MersenneTwister.prototype.random = function () {
        return this.genrand_int32() * (1.0 / 4294967296.0);
        /* divided by 2^32 */
    };

    /* generates a random number on (0,1)-real-interval */
    MersenneTwister.prototype.genrand_real3 = function () {
        return (this.genrand_int32() + 0.5) * (1.0 / 4294967296.0);
        /* divided by 2^32 */
    };

    /* generates a random number on [0,1) with 53-bit resolution*/
    MersenneTwister.prototype.genrand_res53 = function () {
        var a = this.genrand_int32()>>>5, b = this.genrand_int32()>>>6;
        return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
    };

    // BlueImp MD5 hashing algorithm from https://github.com/blueimp/JavaScript-MD5
    var BlueImpMD5 = function () {};

    BlueImpMD5.prototype.VERSION = '1.0.1';

    /*
    * Add integers, wrapping at 2^32. This uses 16-bit operations internally
    * to work around bugs in some JS interpreters.
    */
    BlueImpMD5.prototype.safe_add = function safe_add(x, y) {
        var lsw = (x & 0xFFFF) + (y & 0xFFFF),
            msw = (x >> 16) + (y >> 16) + (lsw >> 16);
        return (msw << 16) | (lsw & 0xFFFF);
    };

    /*
    * Bitwise rotate a 32-bit number to the left.
    */
    BlueImpMD5.prototype.bit_roll = function (num, cnt) {
        return (num << cnt) | (num >>> (32 - cnt));
    };

    /*
    * These functions implement the five basic operations the algorithm uses.
    */
    BlueImpMD5.prototype.md5_cmn = function (q, a, b, x, s, t) {
        return this.safe_add(this.bit_roll(this.safe_add(this.safe_add(a, q), this.safe_add(x, t)), s), b);
    };
    BlueImpMD5.prototype.md5_ff = function (a, b, c, d, x, s, t) {
        return this.md5_cmn((b & c) | ((~b) & d), a, b, x, s, t);
    };
    BlueImpMD5.prototype.md5_gg = function (a, b, c, d, x, s, t) {
        return this.md5_cmn((b & d) | (c & (~d)), a, b, x, s, t);
    };
    BlueImpMD5.prototype.md5_hh = function (a, b, c, d, x, s, t) {
        return this.md5_cmn(b ^ c ^ d, a, b, x, s, t);
    };
    BlueImpMD5.prototype.md5_ii = function (a, b, c, d, x, s, t) {
        return this.md5_cmn(c ^ (b | (~d)), a, b, x, s, t);
    };

    /*
    * Calculate the MD5 of an array of little-endian words, and a bit length.
    */
    BlueImpMD5.prototype.binl_md5 = function (x, len) {
        /* append padding */
        x[len >> 5] |= 0x80 << (len % 32);
        x[(((len + 64) >>> 9) << 4) + 14] = len;

        var i, olda, oldb, oldc, oldd,
            a =  1732584193,
            b = -271733879,
            c = -1732584194,
            d =  271733878;

        for (i = 0; i < x.length; i += 16) {
            olda = a;
            oldb = b;
            oldc = c;
            oldd = d;

            a = this.md5_ff(a, b, c, d, x[i],       7, -680876936);
            d = this.md5_ff(d, a, b, c, x[i +  1], 12, -389564586);
            c = this.md5_ff(c, d, a, b, x[i +  2], 17,  606105819);
            b = this.md5_ff(b, c, d, a, x[i +  3], 22, -1044525330);
            a = this.md5_ff(a, b, c, d, x[i +  4],  7, -176418897);
            d = this.md5_ff(d, a, b, c, x[i +  5], 12,  1200080426);
            c = this.md5_ff(c, d, a, b, x[i +  6], 17, -1473231341);
            b = this.md5_ff(b, c, d, a, x[i +  7], 22, -45705983);
            a = this.md5_ff(a, b, c, d, x[i +  8],  7,  1770035416);
            d = this.md5_ff(d, a, b, c, x[i +  9], 12, -1958414417);
            c = this.md5_ff(c, d, a, b, x[i + 10], 17, -42063);
            b = this.md5_ff(b, c, d, a, x[i + 11], 22, -1990404162);
            a = this.md5_ff(a, b, c, d, x[i + 12],  7,  1804603682);
            d = this.md5_ff(d, a, b, c, x[i + 13], 12, -40341101);
            c = this.md5_ff(c, d, a, b, x[i + 14], 17, -1502002290);
            b = this.md5_ff(b, c, d, a, x[i + 15], 22,  1236535329);

            a = this.md5_gg(a, b, c, d, x[i +  1],  5, -165796510);
            d = this.md5_gg(d, a, b, c, x[i +  6],  9, -1069501632);
            c = this.md5_gg(c, d, a, b, x[i + 11], 14,  643717713);
            b = this.md5_gg(b, c, d, a, x[i],      20, -373897302);
            a = this.md5_gg(a, b, c, d, x[i +  5],  5, -701558691);
            d = this.md5_gg(d, a, b, c, x[i + 10],  9,  38016083);
            c = this.md5_gg(c, d, a, b, x[i + 15], 14, -660478335);
            b = this.md5_gg(b, c, d, a, x[i +  4], 20, -405537848);
            a = this.md5_gg(a, b, c, d, x[i +  9],  5,  568446438);
            d = this.md5_gg(d, a, b, c, x[i + 14],  9, -1019803690);
            c = this.md5_gg(c, d, a, b, x[i +  3], 14, -187363961);
            b = this.md5_gg(b, c, d, a, x[i +  8], 20,  1163531501);
            a = this.md5_gg(a, b, c, d, x[i + 13],  5, -1444681467);
            d = this.md5_gg(d, a, b, c, x[i +  2],  9, -51403784);
            c = this.md5_gg(c, d, a, b, x[i +  7], 14,  1735328473);
            b = this.md5_gg(b, c, d, a, x[i + 12], 20, -1926607734);

            a = this.md5_hh(a, b, c, d, x[i +  5],  4, -378558);
            d = this.md5_hh(d, a, b, c, x[i +  8], 11, -2022574463);
            c = this.md5_hh(c, d, a, b, x[i + 11], 16,  1839030562);
            b = this.md5_hh(b, c, d, a, x[i + 14], 23, -35309556);
            a = this.md5_hh(a, b, c, d, x[i +  1],  4, -1530992060);
            d = this.md5_hh(d, a, b, c, x[i +  4], 11,  1272893353);
            c = this.md5_hh(c, d, a, b, x[i +  7], 16, -155497632);
            b = this.md5_hh(b, c, d, a, x[i + 10], 23, -1094730640);
            a = this.md5_hh(a, b, c, d, x[i + 13],  4,  681279174);
            d = this.md5_hh(d, a, b, c, x[i],      11, -358537222);
            c = this.md5_hh(c, d, a, b, x[i +  3], 16, -722521979);
            b = this.md5_hh(b, c, d, a, x[i +  6], 23,  76029189);
            a = this.md5_hh(a, b, c, d, x[i +  9],  4, -640364487);
            d = this.md5_hh(d, a, b, c, x[i + 12], 11, -421815835);
            c = this.md5_hh(c, d, a, b, x[i + 15], 16,  530742520);
            b = this.md5_hh(b, c, d, a, x[i +  2], 23, -995338651);

            a = this.md5_ii(a, b, c, d, x[i],       6, -198630844);
            d = this.md5_ii(d, a, b, c, x[i +  7], 10,  1126891415);
            c = this.md5_ii(c, d, a, b, x[i + 14], 15, -1416354905);
            b = this.md5_ii(b, c, d, a, x[i +  5], 21, -57434055);
            a = this.md5_ii(a, b, c, d, x[i + 12],  6,  1700485571);
            d = this.md5_ii(d, a, b, c, x[i +  3], 10, -1894986606);
            c = this.md5_ii(c, d, a, b, x[i + 10], 15, -1051523);
            b = this.md5_ii(b, c, d, a, x[i +  1], 21, -2054922799);
            a = this.md5_ii(a, b, c, d, x[i +  8],  6,  1873313359);
            d = this.md5_ii(d, a, b, c, x[i + 15], 10, -30611744);
            c = this.md5_ii(c, d, a, b, x[i +  6], 15, -1560198380);
            b = this.md5_ii(b, c, d, a, x[i + 13], 21,  1309151649);
            a = this.md5_ii(a, b, c, d, x[i +  4],  6, -145523070);
            d = this.md5_ii(d, a, b, c, x[i + 11], 10, -1120210379);
            c = this.md5_ii(c, d, a, b, x[i +  2], 15,  718787259);
            b = this.md5_ii(b, c, d, a, x[i +  9], 21, -343485551);

            a = this.safe_add(a, olda);
            b = this.safe_add(b, oldb);
            c = this.safe_add(c, oldc);
            d = this.safe_add(d, oldd);
        }
        return [a, b, c, d];
    };

    /*
    * Convert an array of little-endian words to a string
    */
    BlueImpMD5.prototype.binl2rstr = function (input) {
        var i,
            output = '';
        for (i = 0; i < input.length * 32; i += 8) {
            output += String.fromCharCode((input[i >> 5] >>> (i % 32)) & 0xFF);
        }
        return output;
    };

    /*
    * Convert a raw string to an array of little-endian words
    * Characters >255 have their high-byte silently ignored.
    */
    BlueImpMD5.prototype.rstr2binl = function (input) {
        var i,
            output = [];
        output[(input.length >> 2) - 1] = undefined;
        for (i = 0; i < output.length; i += 1) {
            output[i] = 0;
        }
        for (i = 0; i < input.length * 8; i += 8) {
            output[i >> 5] |= (input.charCodeAt(i / 8) & 0xFF) << (i % 32);
        }
        return output;
    };

    /*
    * Calculate the MD5 of a raw string
    */
    BlueImpMD5.prototype.rstr_md5 = function (s) {
        return this.binl2rstr(this.binl_md5(this.rstr2binl(s), s.length * 8));
    };

    /*
    * Calculate the HMAC-MD5, of a key and some data (raw strings)
    */
    BlueImpMD5.prototype.rstr_hmac_md5 = function (key, data) {
        var i,
            bkey = this.rstr2binl(key),
            ipad = [],
            opad = [],
            hash;
        ipad[15] = opad[15] = undefined;
        if (bkey.length > 16) {
            bkey = this.binl_md5(bkey, key.length * 8);
        }
        for (i = 0; i < 16; i += 1) {
            ipad[i] = bkey[i] ^ 0x36363636;
            opad[i] = bkey[i] ^ 0x5C5C5C5C;
        }
        hash = this.binl_md5(ipad.concat(this.rstr2binl(data)), 512 + data.length * 8);
        return this.binl2rstr(this.binl_md5(opad.concat(hash), 512 + 128));
    };

    /*
    * Convert a raw string to a hex string
    */
    BlueImpMD5.prototype.rstr2hex = function (input) {
        var hex_tab = '0123456789abcdef',
            output = '',
            x,
            i;
        for (i = 0; i < input.length; i += 1) {
            x = input.charCodeAt(i);
            output += hex_tab.charAt((x >>> 4) & 0x0F) +
                hex_tab.charAt(x & 0x0F);
        }
        return output;
    };

    /*
    * Encode a string as utf-8
    */
    BlueImpMD5.prototype.str2rstr_utf8 = function (input) {
        return unescape(encodeURIComponent(input));
    };

    /*
    * Take string arguments and return either raw or hex encoded strings
    */
    BlueImpMD5.prototype.raw_md5 = function (s) {
        return this.rstr_md5(this.str2rstr_utf8(s));
    };
    BlueImpMD5.prototype.hex_md5 = function (s) {
        return this.rstr2hex(this.raw_md5(s));
    };
    BlueImpMD5.prototype.raw_hmac_md5 = function (k, d) {
        return this.rstr_hmac_md5(this.str2rstr_utf8(k), this.str2rstr_utf8(d));
    };
    BlueImpMD5.prototype.hex_hmac_md5 = function (k, d) {
        return this.rstr2hex(this.raw_hmac_md5(k, d));
    };

    BlueImpMD5.prototype.md5 = function (string, key, raw) {
        if (!key) {
            if (!raw) {
                return this.hex_md5(string);
            }

            return this.raw_md5(string);
        }

        if (!raw) {
            return this.hex_hmac_md5(key, string);
        }

        return this.raw_hmac_md5(key, string);
    };

    // CommonJS module
    {
        if ('object' !== 'undefined' && module.exports) {
            exports = module.exports = Chance;
        }
        exports.Chance = Chance;
    }

    // Register as an anonymous AMD module
    if (typeof undefined === 'function' && undefined.amd) {
        undefined([], function () {
            return Chance;
        });
    }

    // if there is a importsScrips object define chance for worker
    if (typeof importScripts !== 'undefined') {
        chance = new Chance();
    }

    // If there is a window object, that at least has a document property,
    // instantiate and define chance on the window
    if (typeof window === "object" && typeof window.document === "object") {
        window.Chance = Chance;
        window.chance = new Chance();
    }
})();
});

var chanceGenerators$1 = createCommonjsModule(function (module, exports) {
/*global define*/
(function (root, factory) {
  {
    module.exports = factory(chance_1);
  }
})(commonjsGlobal, function (Chance) {
  function copy (source) {
    var result = {};
    Object.keys(source).forEach(function (key) {
      result[key] = source[key];
    });
    return result
  }

  function unwrap (v) {
    if (Array.isArray(v)) {
      return v.map(unwrap)
    } else if (v && typeof v === 'object' && v.constructor === Object) {
      return Object.keys(v).reduce(function (result, key) {
        result[key] = unwrap(v[key]);
        return result
      }, {})
    } else {
      return v && v.isGenerator ? v() : v
    }
  }

  function ExtendedChance (seed) {
    if (!(this instanceof ExtendedChance)) {
      return new ExtendedChance(seed)
    }

    var that = this;
    var chance = typeof seed === 'undefined'
        ? new Chance()
        : new Chance(seed);

    // Fix that pick provided a count of zero or one does not return an array
    var originalPick = Chance.prototype.pick;
    chance.pick = function (array, count) {
      if (count === 0) {
        return []
      }

      if (count === 1) {
        return [originalPick.call(chance, array, count)]
      }

      return originalPick.call(chance, array, count)
    };

    chance.shape = function (data) {
      return unwrap(data)
    };

    function generatorFunction (name, args, f) {
      f.isGenerator = true;
      f.generatorName = name;
      f.args = args;
      f.toString = function () {
        return name
      };
      return f
    }

    function installMapFunction (generator) {
      generator.map = function (f) {
        var lastValue, lastMappedValue;
        var mapGenerator = generatorFunction(generator.generatorName + '.map', [], function () {
          lastValue = generator();
          lastMappedValue = unwrap(f(lastValue, that));
          return lastMappedValue
        });

        mapGenerator.isMappedGenerator = true;
        mapGenerator.parentGenerator = generator;
        mapGenerator.mapFunction = f;

        if (generator.shrink) {
          mapGenerator.shrink = function (value) {
            if (value === lastMappedValue) {
              return generator.shrink(lastValue).map(f)
            } else {
              return mapGenerator
            }
          };
        }

        installMapFunction(mapGenerator);

        return mapGenerator
      };
    }

    var overrides = {
      n: function (generator, count) {
        return createGenerator('n', [generator, count], [generator])
      },
      pickset: function (data, count) {
        var picksetGenerator = generatorFunction('pickset', [data, count], function () {
          picksetGenerator.lastValue = chance.pickset(data, unwrap(count));
          picksetGenerator.lastUnwrappedValue = unwrap(picksetGenerator.lastValue);
          return picksetGenerator.lastUnwrappedValue
        });

        installMapFunction(picksetGenerator);

        picksetGenerator.shrink = function (data) {
          return shrinkers.pickset(picksetGenerator, data)
        };

        return picksetGenerator
      },
      unique: function (generator, count, options) {
        return createGenerator('unique', [generator, count], [generator])
      }
    };

    function minMaxShrinker (generator, data) {
      var currentLimits = generator.args[0] || {};
      var limits = copy(currentLimits);

      var value = typeof data === 'string'
        ? parseFloat(data.replace(/^[^\d]*/, ''))
        : data;

      if (value < 0 && value < (currentLimits.max || 0)) {
        var max = currentLimits.max || 0;
        limits = {
          min: value,
          max: Math.min(0, max)
        };
      } else if (value > 0 && value > (currentLimits.min || 0)) {
        var min = currentLimits.min || 0;
        limits = {
          min: Math.max(0, min),
          max: value
        };
      } else {
        return that.constant(data)
      }

      return that[generator.generatorName](limits)
    }

    var shrinkers = {
      n: function (generator, data) {
        if (data.length === 0) {
          return that.constant(data)
        }

        var count = generator.args[1];
        if (count && count.shrink) {
          count = count.shrink(data.length);
        } else {
          count = data.length;
        }

        var dataGenerator = generator.args[0];
        if (dataGenerator.shrink) {
          return that.pickset(data.map(dataGenerator.shrink), count)
        } else {
          return that.pickset(data, count)
        }
      },
      pick: function (generator, data) {
        if (Array.isArray(data)) {
          return shrinkers.pickset(generator, data)
        } else {
          return shrinkers.pickone(generator, data)
        }
      },
      pickone: function (generator, data) {
        return that.constant(data)
      },
      pickset: function (generator, data) {
        if (data.length === 0) {
          return that.constant(data)
        }

        var shrinkable = false;
        var count = generator.args[1];
        if (count && count.shrink) {
          shrinkable = true;
          count = count.shrink(data.length);
        }

        var shrinkableData = (generator.lastValue || []).some(function (g) {
          return g && g.shrink
        });

        shrinkable = shrinkable || shrinkableData;

        if (shrinkableData && data.length < 10 && generator.lastUnwrappedValue === data) {
          data = generator.lastValue.map(function (g, i) {
            return g && g.shrink
              ? g.shrink(data[i])
              : data[i]
          });
        } else {
          data = generator.lastValue;
        }

        if (!shrinkable) {
          return that.constant(data)
        }

        return that.pickset(data, count)
      },
      unique: function (generator, data) {
        var count = generator.args[1];
        if (count && count.shrink) {
          count = count.shrink(data.length);
        } else {
          count = data.length;
        }

        var dataGenerator = generator.args[0];
        if (dataGenerator.shrink) {
          return that.pickset(data.map(dataGenerator.shrink), count)
        } else {
          return that.pickset(data, count)
        }
      },
      shape: function (generator, data) {
        var shapeGenerators = generator.args[0];
        var shrunk = false;
        var newShape = Object.keys(shapeGenerators).reduce(function (result, key) {
          var entry = shapeGenerators[key];
          if (entry && typeof entry.shrink === 'function') {
            shrunk = true;
            result[key] = entry.shrink(data[key]);
          } else {
            result[key] = entry;
          }

          return result
        }, {});

        if (shrunk) {
          return that.shape(newShape)
        } else {
          return that.constant(data)
        }
      },
      string: function (generator, data) {
        var currentLimits = generator.args[0] || {};
        var limits = copy(currentLimits);

        var pool = {};
        for (var i = 0; i < data.length; i += 1) {
          pool[data[i]] = true;
        }
        limits.pool = Object.keys(pool).join('');

        if (data.length === 0) {
          return that.constant(data)
        } else if (typeof limits.length === 'undefined') {
          limits.length = that.integer({ min: 0, max: data.length });
        } else if (limits.length && limits.length.shrink) {
          limits.length = limits.length.shrink(data.length);
        } else {
          return that.constant(data)
        }

        return that.string(limits)
      },
      integer: minMaxShrinker,
      natural: minMaxShrinker,
      floating: minMaxShrinker,
      year: minMaxShrinker,
      altitude: minMaxShrinker,
      depth: minMaxShrinker,
      latitude: minMaxShrinker,
      longitude: minMaxShrinker,
      dollar: minMaxShrinker
    };

    function createGenerator (name, args, omitUnwap) {
      var omitUnwrapIndex = {};

      omitUnwap && args.forEach(function (arg, i) {
        if (omitUnwap.indexOf(arg) !== -1) {
          omitUnwrapIndex[i] = true;
        }
      });

      var g = generatorFunction(name, args, function () {
        if (arguments.length === 0) {
          return chance[name].apply(chance, args.map(function (arg, i) {
            return omitUnwrapIndex[i] ? arg : unwrap(arg)
          }))
        } else {
          return createGenerator(
            name,
            Array.prototype.slice.call(arguments)
          )
        }
      });

      var shrinker = shrinkers[name];
      if (shrinker) {
        g.shrink = function (data) {
          return shrinker(g, data)
        };
      } else {
        g.shrink = function (data) {
          return that.constant(data)
        };
      }

      installMapFunction(g);

      return g
    }

    ['shape'].concat(Object.keys(Chance.prototype)).forEach(function (key) {
      var property = chance[key];
      if (typeof property === 'function') {
        if (overrides[key]) {
          that[key] = generatorFunction(key, [], overrides[key]);
        } else {
          that[key] = createGenerator(key, []);
        }
      } else {
        that[key] = property;
      }
    });

    that.identity = that.constant = generatorFunction('constant', [], function (data) {
      var constantGenerator = generatorFunction('constant', [data], function () {
        return data
      });

      installMapFunction(constantGenerator);

      return constantGenerator
    });

    that.array = generatorFunction('array', [], function (generator, count) {
      if (typeof count === 'undefined') {
        return that.n(generator, that.natural({ max: 50 }))
      } else {
        return that.n(generator, count)
      }
    });

    that.sequence = generatorFunction('sequence', [], function (fn, count) {
      count = typeof count === 'undefined'
        ? that.natural({ max: 50 })
        : count;

      var g = generatorFunction('sequence', [fn, count], function () {
        var context = {};
        var previous = null;
        var valueGenerator = function () {
          var result = previous === null
              ? unwrap(fn(context))
              : unwrap(fn(context, previous));

          previous = result;

          return result
        };

        return that.array(valueGenerator, count)()
      });

      g.shrink = function (data) {
        if (data.length === 0) {
          return that.constant([])
        }

        var count = g.args[1];
        if (count && count.shrink) {
          count = count.shrink(data.length);
        } else {
          count = data.length;
        }
        var valueGenerator = g.args[0];
        return that.sequence(valueGenerator, count)
      };

      installMapFunction(g);

      return g
    });
  }

  return ExtendedChance
});
});

const { array, natural, sequence, shape } = new chanceGenerators$1(42);

unexpected$1.use(unexpectedCheck);

describe("repeat", () => {
  let container;

  beforeEach(() => {
    container = document.createElement("div");
  });

  it("is stable while swapping items", () => {
    const initialItems = [0, 1, 2, 3, 4];

    const swapSequence = sequence(() => ({
      from: natural({ max: initialItems.length - 1 }),
      to: natural({ max: initialItems.length - 1 })
    }));

    unexpected$1(
      swaps => {
        const t = items =>
          html`<ul>${repeat(items, i => i, i => html`<li>${i}</li>`)}</ul>`;

        const items = initialItems.slice();

        for (let swap of swaps) {
          const temp = items[swap.to];
          items[swap.to] = items[swap.from];
          items[swap.from] = temp;

          render(t(items), container);
          unexpected$1(container.textContent, "to be", items.join(""));
        }
      },
      "to be valid for all",
      swapSequence
    );
  });
});

var repeat_spec = "";

return repeat_spec;

}());
