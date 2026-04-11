(function () {
   'use strict';

   /** @module General-purpose utilities */


   function getOwn(obj, prop) {
      return Object.hasOwn(obj, prop) ? obj[prop] : undefined;
   }


   function addAll(S, xs) {
      for (let x of xs) {
         S.add(x);
      }
   }


   function chunkify(arr, chunk) {
      let chunks = [];

      for (let i = 0; i < arr.length; i += chunk) {
         chunks.push(arr.slice(i, i + chunk));
      }

      return chunks;
   }


   function msetAdd(mset, item) {
      mset.set(item, (mset.get(item) ?? 0) + 1);
   }


   function msetAddAll(mset, items) {
      for (let item of items) {
         msetAdd(mset, item);
      }
   }


   function msetDelete(mset, item) {
      mset.set(item, (mset.get(item) ?? 0) - 1);
   }


   function msetDeleteAll(mset, items) {
      for (let item of items) {
         msetDelete(mset, item);
      }
   }


   function* msetItems(mset) {
      for (let [item, count] of mset) {
         if (count > 0) {
            yield item;
         }
      }
   }


   function msetHas(mset, item) {
      return (mset.get(item) ?? 0) > 0;
   }


   function chronoVersion(v0, v1) {
      v0 = v0.split('.').map(Number);
      v1 = v1.split('.').map(Number);

      let i = 0;

      while (i < v0.length && i < v1.length) {
         if (v0[i] < v1[i]) {
            return true;
         }
         if (v0[i] > v1[i]) {
            return false;
         }

         i += 1;
      }

      return true;
   }

   /**
    * TREE ::= {
    *    key: NODE,
    *    ...
    * }
    * 
    * NODE ::=
    *    true |
    *    {
    *       [soFar]: true,   // optional
    *       key: NODE,
    *       ...
    *    }
    */

   function ensureNodeAt(tree, domain) {
      let parts = domain.split('.');
      let node = tree;

      while (parts.length > 0) {
         let part = parts.pop();

         if (!Object.hasOwn(node, part)) {
            node[part] = {};
         }

         node = node[part];
      }

      return node;
   }


   function* nodeChain(tree, domain) {
      let parts = domain.split('.');
      let node = tree;

      while (node !== undefined) {
         yield node;

         if (parts.length === 0) {
            break;
         }

         node = getOwn(node, parts.pop());
      }
   }



   /////////////////////////////
   // Domain tree: for inclusion
   const soFar = '';


   function isIncluded(node) {
      return Object.hasOwn(node, soFar);
   }


   function covers(tree, domain) {
      for (let node of nodeChain(tree, domain)) {
         if (isIncluded(node)) {
            return true;
         }
      }

      return false;
   }


   /**
    * Add 'domain' to the tree.
    * 
    * @return: {needSave, needUpdate}
    *    - needSave: whether the tree should be re-saved to the storage
    *    - needUpdate: whether the 'updateDynamicRules' should be called
    */
   function add(tree, domain) {
      let target = ensureNodeAt(tree, domain);

      if (isIncluded(target)) {
         return {
            needSave: false,
            needUpdate: false,
         }
      }

      target[soFar] = true;

      let needUpdate = true;

      for (let node of nodeChain(tree, domain)) {
         if (isIncluded(node) && node !== target) {
            needUpdate = false;
            break;
         }
      }

      return {
         needSave: true,
         needUpdate: needUpdate,
      }
   }


   /**
    * Domain list to be used in "requestDomains:" rule condition. This does not include
    * nested domains, e.g. if we have both "korrespondent.net" and "ua.korrespondent.net",
    * then we'll only return ["korrespondent.net"].
    */ 
   function requestDomains(tree) {
      function* go(path, node) {
         if (isIncluded(node)) {
            yield path;
         }
         else {
            for (let part in node) {
               if (part !== soFar) {
                  yield* go(joinDomain(part, path), node[part]);
               }
            }
         }
      }

      return Array.from(go('', tree));
   }


   function joinDomain(part, domain) {
      return domain ? `${part}.${domain}` : part;
   }

   const reHttp = /^https?:\/\//;


   function makeIncExcCounter(name) {
      let I = new Map;
      let E = new Map;

      let pI = `+I${name}`;
      let mI = `-I${name}`;
      let pE = `+E${name}`;
      let mE = `-E${name}`;

      return {
         process(node) {
            if (Object.hasOwn(node, pI)) {
               msetAddAll(I, node[pI]);
            }
            if (Object.hasOwn(node, mI)) {
               msetDeleteAll(I, node[mI]);
            }
            if (Object.hasOwn(node, pE)) {
               msetAddAll(E, node[pE]);
            }
            if (Object.hasOwn(node, mE)) {
               msetDeleteAll(E, node[mE]);
            }
         },

         *refs() {
            for (let ref of msetItems(I)) {
               if (!msetHas(E, ref)) {
                  yield ref;
               }
            }
         }
      }
   }

   const RulePriority = {
      GENERIC_BLOCK: 1,
      GENERIC_ALLOW: 2,
      SPECIFIC_BLOCK: 3,
      ALLOW: 4,
      WHITELIST: 5,
   };

   class Key {
      constructor({name, defaultFactory}) {
         this.name = name;
         this.defaultFactory = defaultFactory;
         this.promise = null;
      }

      then(doThis) {
         if (this.promise !== null) {
            return this.promise.then(doThis);
         }

         let promise;

         promise = this.promise = chrome.storage.local
            .get({[this.name]: this.defaultFactory()})
            .then(result => result[this.name])
            .then(value =>
               this.promise === promise || this.promise === null ? value : this.promise);

         return this.promise.then(doThis);
      }

      set(value) {
         this.promise = Promise.resolve(value);
      }

      // Stubs (do nothing if not overriden)
      setFromSave(value) {}
      setFromListener(value) {}
      reset() {}
      *getWatchers() {}
      addWatcher(watcher) {
         return false;   // should call watcher right away
      }
   }


   class OwnedKey extends Key {
      constructor({persisted, ...rest}) {
         super(rest);
         this.persisted = persisted;
      }

      reset() {
         if (!this.persisted) {
            this.promise = null;
         }
      }

      setFromSave(value) {
         this.set(value);
      }
   }


   class SharedKey extends Key {
      constructor(args) {
         super(args);
         // false, true (changed when no watchers registered), #<Set>
         this.watchers = false;
      }

      setFromListener(value) {
         this.set(value);

         if (this.watchers === false) {
            this.watchers = true;
         }
      }

      addWatcher(watcher) {
         let shouldCall = this.watchers === true;

         if (this.watchers === false || this.watchers === true) {
            this.watchers = new Set;
         }

         this.watchers.add(watcher);

         return shouldCall;
      }

      *getWatchers() {
         if (this.watchers !== false && this.watchers !== true) {
            yield* this.watchers;
         }
      }
   }


   const KEYS = [
      {name: 'isOn', defaultFactory: () => true},
      {name: 'numBlockedRequests', defaultFactory: () => 0},
      {name: 'isRated', defaultFactory: () => false},
      {name: 'hardWhitelistTree', defaultFactory: () => ({})},
      {name: 'softWhitelistTree', defaultFactory: () => ({})},
      {name: 'softWhitelist', defaultFactory: () => []},
      {name: 'cosmetics', defaultFactory: () => ({})}
   ];


   let Storage;


   /**
    * - persisted: don't get reset in 'resetCache()', i.e. these keys preserve their value.
    * - shared: keys are updated in 'onChange' listener rather than in the 'save()'. Use
    *   these if you expect a key to be set from other places, and you want to be aware of
    *   it.
    */
   function initializeStorageCache({persisted=[], shared=[]}) {
      Storage = {};

      for (let params of KEYS) {
         if (shared.includes(params.name)) {
            Storage[params.name] = new SharedKey(params);
         }
         else {
            Storage[params.name] = new OwnedKey({
               ...params,
               persisted: persisted.includes(params.name)
            });
         }
      }

      Storage = Object.freeze(Storage);

      if (shared.length > 0) {
         chrome.storage.local.onChanged.addListener(change => {
            let watchers = new Set;

            for (let [keyName, {newValue}] of Object.entries(change)) {
               if (newValue === undefined) {
                  // A key was deleted, should not normally happen
                  continue;
               }

               let key = Storage[keyName];

               key.setFromListener(newValue);

               for (let watcher of key.getWatchers()) {
                  watchers.add(watcher);
               }
            }

            for (let watcher of watchers) {
               watcher();
            }
         });
      }
   }


   function save(spec) {
      for (let [keyName, value] of Object.entries(spec)) {
         Storage[keyName].setFromSave(value);
      }

      return chrome.storage.local.set(spec);
   }


   function resetCache() {
      for (let key of Object.values(Storage)) {
         key.reset();
      }
   }

   async function loadHardWhitelistTree() {
      let resp = await fetch(chrome.runtime.getURL('res/net/hard-whitelist.json'));
      let [{condition: {requestDomains: domains}}] = await resp.json();

      let tree = {};

      for (let domain of domains) {
         add(tree, domain);
      }

      return tree;
   }


   async function isHostnameWhitelisted(hostname) {
      return (
         covers(await Storage.hardWhitelistTree, hostname) ? 'hard' :
         covers(await Storage.softWhitelistTree, hostname)
      );
   }


   const SOFT_WHITELIST_RULE_ID = 1001;


   async function effectuateSoftWhitelist(tree) {
      let requestDomains$1 = requestDomains(tree);

      if (requestDomains$1.length > 0) {
         await chrome.declarativeNetRequest.updateDynamicRules({
            addRules: [{
               id: SOFT_WHITELIST_RULE_ID,
               priority: RulePriority.WHITELIST,
               condition: {
                  requestDomains: requestDomains$1,
                  resourceTypes: ['main_frame', 'sub_frame']
               },
               action: {
                  type: 'allowAllRequests'
               }
            }],
            removeRuleIds: [SOFT_WHITELIST_RULE_ID]
         });
      }
      else {
         await chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [SOFT_WHITELIST_RULE_ID]
         });
      }
   }

   const Icon = {
      enabled: '/img/icon16.png',
      disabled: '/img/icon-disabled.png',
   };



   async function isEnabledFor(urlo) {
      return (
         await Storage.isOn &&
         reHttp.test(urlo.href) &&
         !await isHostnameWhitelisted(urlo.hostname)
      )
   }


   async function refreshTabIcon({tabId, urlo}) {
      let enabled = await isEnabledFor(urlo);

      await chrome.action.setIcon({
         path: enabled ? Icon.enabled : Icon.disabled,
         tabId: tabId
      });

      return enabled;
   }


   async function loadJsonResource(res) {
      let resp = await fetch(chrome.runtime.getURL(res));
      let json = await resp.json();

      return json;
   }


   async function loadTextResource(res) {
      let resp = await fetch(chrome.runtime.getURL(res));
      let text = await resp.text();

      return text;
   }


   class Lazy {
      constructor(func) {
         this.func = func;
         this.promise = null;
      }

      then(doThis) {
         if (this.promise === null) {
            this.promise = this.func();
            this.func = null;
         }

         return this.promise.then(doThis);
      }
   }

   class InvalidCss4 extends Error {
      constructor(streamOrMsg) {
         if (streamOrMsg instanceof Stream) {
            super(`Invalid CSS4 selector, remains to parse: ${streamOrMsg.sliceAhead()}`);
         }
         else {
            super(streamOrMsg);
         }
      }
   }


   class Stream {
      constructor(str) {
         this.str = str;
         this.i = 0;
      }

      get done() {
         return this.i >= this.str.length;
      }

      lookingAt(thg) {
         if (typeof thg === 'string') {
            return this.str.slice(this.i, this.i + thg.length) === thg;
         }
         else {
            thg.lastIndex = this.i;
            return thg.test(this.str);
         }
      }

      get char() {
         return this.str[this.i];
      }

      consumeChar() {
         if (this.done) {
            throw new InvalidCss4(this);
         }

         let char = this.char;
         this.next();
         return char;
      }

      next() {
         this.i += 1;
      }

      sliceAhead() {
         return this.str.slice(this.i);
      }

      tryConsume(re) {
         re.lastIndex = this.i;

         let mo = re.exec(this.str);
         if (mo) {
             this.i += mo[0].length;
         }
         return mo;
      }

      consume(re) {
         let mo = this.tryConsume(re);
         if (mo === null) {
             throw new InvalidCss4(this);
         }
         return mo;
      }

      eatUpto(re) {
         re.lastIndex = this.i;

         let mo = re.exec(this.str);
         let j = mo ? mo.index : this.str.length;
         let res = this.str.slice(this.i, j);

         this.i = j;

         return res;
      }

      skipWhitespace() {
         let re = /\s*/y;
         re.lastIndex = this.i;
         re.test(this.str);
         this.i = re.lastIndex;
      }
   }


   const {
      reAttribute,
      reParenGroupOfInterest,
      rePseudo,
      reTextOrRegexInParen,
      reCssPropValueInParen
   } = (function () {
      let unit = "(?:\\\\?.)";
      let esc = "(?:\\\\.)";
      let string = `(?<quote>["'])(?<string>${unit}*?)\\k<quote>`;
      let range = `\\[${unit}+?\\]`;
      let regex = `/(?<regex>(?:${esc}|${range}|.)+?)/(?<regexModifiers>[a-z]*)`;

      let attr = `(?<attr>.+?)`;
      let text = `(?<text>.+?)`;
      let attribute = `\\[\\s*${attr}\\s*(?:=\\s*(?:${string}|${text}))?\\s*\\]`;

      let pseudo = `::?[-\\w]+`;

      let textOrRegexInParen = `\\(\\s*(?:${regex}|${text})\\s*\\)`;

      let prop = `(?<prop>.+?)`;
      let cssPropValueInParen = `\\(${prop}\\s*:\\s*(?:${regex}|${text})\\s*\\)`;

      let parenGroupOfInterest = `(?:${string}|${regex}|.)*?(?<paren>[()])`;

      return {
         reAttribute: new RegExp(attribute, 'y'),
         rePseudo: new RegExp(pseudo, 'y'),
         reTextOrRegexInParen: new RegExp(textOrRegexInParen, 'y'),
         reCssPropValueInParen: new RegExp(cssPropValueInParen, 'y'),
         reParenGroupOfInterest: new RegExp(parenGroupOfInterest, 'y'),
      }
   })();


   function compileSelector(selector) {
      let stream = new Stream(selector);

      function consumeComplex() {
         let
            firstLink = {next: null},
            lastLink = firstLink;

         function link(newLink) {
            lastLink.next = newLink;
            lastLink = newLink;
         }

         for (;;) {
            stream.skipWhitespace();

            while (stream.lookingAt(/[~+]/y)) {
               link(jsDeepener(stream.consumeChar()));

               stream.skipWhitespace();

               let {plain: subplain, filters: subfilters} = consumeCompound();

               if (subplain) {
                  subfilters.push(matchesSelectorFilter(subplain));
               }

               if (subfilters.length === 0) {
                  throw new InvalidCss4(stream);
               }

               link(filtersAsLink(subfilters));

               stream.skipWhitespace();
            }

            let prefix;

            if (stream.lookingAt('>')) {
               prefix = ':scope > ';
               stream.next();
               stream.skipWhitespace();
            }
            else if (firstLink === lastLink) {
               prefix = '';
            }
            else {
               prefix = ':scope ';
            }

            let {plain, filters} = consumePlainCompounds();

            if (!plain) {
                break;
            }

            link(nativeDeepener(prefix + plain));

            if (filters === null) {
               break;
            }


            if (filters.length > 1) {
             for (let f of filters) {
                link(filtersAsLink([f]));
             }
            }
            else {
               link(filtersAsLink(filters));
            }
         }

         return firstLink.next;
      }

      function consumePlainCompounds() {
         let plainCompounds = [];

         for (;;) {
            if (stream.done || stream.lookingAt(',')) {
               return {plain: plainCompounds.join('\x20'), filters: null};
            }

            let {plain, filters} = consumeCompound();

            if (!plain && filters.length === 0) {
               throw new InvalidCss4(stream);
            }

            if (plain) {
               plainCompounds.push(plain);
            }

            if (filters.length > 0) {
               if (!plain) {
                  plainCompounds.push('*');
               }
               return {plain: plainCompounds.join('\x20'), filters};
            }

            stream.skipWhitespace();

            if (stream.lookingAt(/[>+~]/y)) {
               plainCompounds.push(stream.consumeChar());
               stream.skipWhitespace();
            }
         }
      }

      function consumeCompound() {
         const reStop = /[\[:\s>+~,]/g;

         let
             chunks = [],
             filters = []
         ;

         for (;;) {
            let chunk = stream.eatUpto(reStop);
            chunks.push(chunk);

            if (stream.done) {
                break;
            }
            else if (stream.char === '[') {
               let res = consumeAttribute();
               if (typeof res === 'string') {
                   chunks.push(res);
               }
               else {
                   filters.push(res);
               }
            }
            else if (stream.char === ':') {
               let res = consumePseudo();
               if (typeof res === 'string') {
                   chunks.push(res);
               }
               else {
                   filters.push(res);
               }
            }
            else {
               break;
            }
         }

         return {plain: chunks.join(''), filters};
      }

      function consumeAttribute() {
         let {0: chunk, groups: {attr, string}} = stream.consume(reAttribute);
         if (attr === '-ext-has' || attr === '-abp-has') {
            if (!string) {
                return chunk;
            }
            // TODO: do we need to unescape string?
            return hasFilter(compileSelector(string));
         }
         else if (attr === '-ext-contains' || attr === '-abp-contains') {

            if (!string) {
                return chunk;
            }
            // TODO: do we need to unescape string?

            return containsFilter({text: string});
         }
         else {
            return chunk;
         }
      }

      function consumePseudo() {
         let [pseudo] = stream.consume(rePseudo);

         if (pseudo === ':has' || pseudo === ':-abp-has') {
            let selector = consumeParenGroup();
            return hasFilter(compileSelector(selector));
         }
         else if (/^:matches-css(?:-before|-after)?$/.test(pseudo)) {
            let pseudoElt = pseudo.endsWith('-after') ? ':after' :
                                 pseudo.endsWith('-before') ? ':before' :
                                 null,
               {groups: {prop, regex, regexModifiers, text}} = stream.consume(reCssPropValueInParen);

            if (regex) {
               validateRegex(regex, regexModifiers);
               return matchesCssFilter(prop, {regex, regexModifiers}, pseudoElt);
            }
            else {
               return matchesCssFilter(prop, {text}, pseudoElt);
            }
         }
         else if (pseudo === ':contains' || pseudo === ':-abp-contains') {
            let {
                groups: {regex, regexModifiers, text}
            } = stream.consume(reTextOrRegexInParen);

            if (regex) {
               validateRegex(regex, regexModifiers);
               return containsFilter({regex, regexModifiers});
            }
            else {
               return containsFilter({text});
            }
         }
         else if (pseudo === ':not') {
            let selector = consumeParenGroup();
            let chain = compileSelector(selector);

            if (isChainPlainSelector(chain)) {
               return pseudo + '(' + selector + ')';
            }
            else {
               return notFilter(chain);
            }
         }
         else if (pseudo === ':upward') {
            let selector = consumeParenGroup();
            let output;
            if (!Number.isInteger(+selector)){
               let chain = compileSelector(selector);
               output = (isChainPlainSelector(chain)) ? chain.selector :  chain;
            }
            else {
               if (Number.isNaN(+selector) || +selector < 1 || +selector >= 256) {
                  throw new InvalidCss4(selector);
               }
               output = convertNthAncestor(selector);
            }

            return ancestorFilter('upward', output, selector)
         }
         else if (pseudo === ':nth-ancestor') {
            let selector = consumeParenGroup();
            let deep = Number(selector);
            if (Number.isNaN(deep) || deep < 1 || deep >= 256) {
               throw new InvalidCss4(selector);
            }

            let xpath = convertNthAncestor(selector);
            return ancestorFilter('nth-ancestor', xpath, selector)
         }
         else if (pseudo === ':xpath') {
            let xpath = consumeParenGroup();
            try {
               document.createExpression(xpath, null);
            } catch (e) {
               throw new InvalidCss4(xpath)
            }

            let xpathSelector = XpathSelector(xpath, stream.str);
            xpathSelector.specific = !!stream.str.indexOf(':xpath');
            return xpathSelector
         }
         else {
            // Skip optional parentheses, no nested parens expected
            let [parens] = stream.tryConsume(/\(.*?\)/y) || [''];
            return pseudo + parens;
         }
      }

      function consumeParenGroup() {
         let nesting = 0, i = stream.i;

         for (;;) {
            let {groups: {paren}} = stream.consume(reParenGroupOfInterest);

            nesting += paren === '(' ? 1 : -1;

            if (nesting === 0) {
               break;
            }
         }

         return stream.str.slice(i + 1, stream.i - 1);
      }

      let chain = consumeComplex();

      stream.skipWhitespace();

      if (stream.done) {
         return chain;
      }

      let chains = [chain];

      chain = {
         type: 'merger',
         chains: chains
      };

      while (stream.lookingAt(',')) {
         stream.next();
         chains.push(consumeComplex());
         stream.skipWhitespace();
      }

      if (!stream.done) {
         throw new InvalidCss4(stream);
      }

      return chain;
   }


   function isChainPlainSelector(chain) {
      return chain.type === 'deepener' && chain.selector && chain.next == null;
   }


   function validateRegex(regex, regexModifiers) {
      try {
         // The following assignment is done only because simple "new RegExp()" gets optimized away by
         // Rollup.  I wasn't able to quickly figure out how to instruct it not to be that smart.
         validateRegex.re = new RegExp(regex, regexModifiers);
      }
      catch (e) {
         if (e instanceof SyntaxError) {
            throw new InvalidCss4(`Invalid regex: ${regex}`);
         }
      }
   }


   function nativeDeepener(selector) {
      return {
         type: 'deepener',
         selector: selector
      };
   }


   function jsDeepener(combinator) {
      return {
         type: 'deepener',
         combinator: combinator
      };
   }


   function matchesSelectorFilter(selector) {
       return {
            type: 'matches-selector',
            selector: selector
       }
   }


   function matchesCssFilter(prop, value, pseudoElt) {
       return {
            type: 'matches-css',
            prop: prop,
            value: value,
            pseudoElt: pseudoElt
       };
   }


   function containsFilter(what) {
      return {
          type: 'contains',
          what: what
      };
   }


   function hasFilter(chain) {
      return {
          type: 'has',
          chain: chain
      };
   }


   function notFilter(chain) {
      return {
         type: 'not',
         chain: chain
      }
   }

   function ancestorFilter(type, pseudoClassArg, selectorText) {
      return {
         type: type,
         pseudoClassArg: pseudoClassArg,
         selectorText: selectorText
      };
   }


   function convertNthAncestor(deep) {
      let result = '..';

      while (deep > 1) {
         result += '/..';
         deep--;
      }

      return result;
   }

   function XpathSelector(xpath, selectorText) {
      let NO_SELECTOR_MARKER = ':xpath(//';
      let BODY_SELECTOR_REPLACER = 'body:xpath(//';
      let modifiedSelectorText = selectorText;

      if (selectorText.startsWith(NO_SELECTOR_MARKER)) {
         modifiedSelectorText = selectorText.replace(NO_SELECTOR_MARKER, BODY_SELECTOR_REPLACER);
      }

      return ancestorFilter('xpath', xpath, modifiedSelectorText)
   }

   function filtersAsLink(filters) {
      const types = ['matches-selector', 'contains', 'matches-css', 'has', 'upward', 'nth-ancestor', 'xpath'];
      const pseudoElts = [':before', null, ':after'];
      filters = filters.slice();

      filters.sort((f1, f2) => {
         let idx1 = types.indexOf(f1.type), idx2 = types.indexOf(f2.type);
         if (idx1 !== 2 || idx2 !== 2) {
            return idx1 - idx2;
         }

         // Both are matches-css. So compare pseudoElt properties, too
         return pseudoElts.indexOf(f1.pseudoElt) - pseudoElts.indexOf(f2.pseudoElt);
      });
      let i = filters.findIndex(f => f.type === 'matches-css');
      let ancestor = filters.findIndex(f => new RegExp(/upward|xpath|nth-ancestor/).test(f.type)); //|'nth-ancestor'|'xpath'

      if (i !== -1) {
         // Merge consecutive matches-css filters that have the same pseudoElt
         while (i < filters.length && filters[i].type === 'matches-css') {
            let props = {
               [filters[i].prop]: filters[i].value
            };
            let j = i + 1;

            while (j < filters.length &&
                      filters[j].type === 'matches-css' &&
                      filters[j].pseudoElt === filters[i].pseudoElt) {
               props[filters[j].prop] = filters[j].value;
               j += 1;
            }

            filters.splice(i, j - i, {
               type: 'matches-css',
               pseudoElt: filters[i].pseudoElt,
               props: props
            });

            i = i + 1;
         }
      }

      if (ancestor !== -1) {
         return filters.find(f => new RegExp(/upward|xpath|nth-ancestor/).test(f.type))
      }


      return {
         type: 'filter',
         filters: filters
      }
   }

   /**
    * {
    *    "fids": {
    *       "1001": DOMAIN_TREE,
    *       ...
    *    },
    *    "sel": [".ads", ...],
    *    "css": [".ads { margin-top: 0 }", ...]
    * }
    */
   let jsonCss = new Lazy(() => loadJsonResource('res/cosmetics/css.json'));


   async function applicableCssRules(hostname, excludeGeneric) {
      let res = await jsonCss;
      let enabledFilters = await chrome.declarativeNetRequest.getEnabledRulesets();

      let Csel = makeIncExcCounter('sel');
      let Ccss = makeIncExcCounter('css');

      for (let fid of enabledFilters) {
         for (let node of nodeChain(res['fids'][fid], hostname)) {
            if (excludeGeneric && node === res['fids'][fid]) {
               continue;
            }

            Csel.process(node);
            Ccss.process(node);
         }
      }

      return {
         sel: Array.from(Csel.refs(), n => res['sel'][n]),
         css: Array.from(Ccss.refs(), n => res['css'][n]),
      }
   }


   async function collectCss(hostname, excludeGeneric) {
      let {sel, css} = await applicableCssRules(hostname, excludeGeneric);

      let selPieces = Array.from(
         chunkify(sel, 10),
         chunk => chunk.join(',') + "\n{\n  display: none !important;\n}"
      );

      return selPieces.join('\n\n') + css.join('\n\n');
   }


   /**
    * {
    *    "fids": {
    *       "1001": DOMAIN_TREE,
    *       ...
    *    },
    *    "reg": [
    *       "ads/.*[a-z]",
    *       ...
    *    ]
    * }
    */
   let jsonGenerichide = new Lazy(() => loadJsonResource('res/cosmetics/generichide.json'));

   let regexCache = new Map;


   async function shouldExcludeGeneric(urlo) {
      let res = await jsonGenerichide;
      let enabledFilters = await chrome.declarativeNetRequest.getEnabledRulesets();
      let regexes = new Set;

      for (let fid of enabledFilters) {
         for (let node of nodeChain(res['fids'][fid], urlo.hostname)) {
            if (!Object.hasOwn(node, '+')) {
               continue;
            }

            if (node['+'] === true) {
               return true;
            }

            addAll(regexes, node['+']);
         }
      }

      for (let num of regexes) {
         if (!regexCache.has(num)) {
            regexCache.set(num, new RegExp(res['reg'][num]));
         }

         if (regexCache.get(num).test(urlo.href)) {
            return true;
         }
      }

      return false;
   }


   /**
    * {
    *    "fids": {
    *       "1001": DOMAIN_TREE,
    *       ...
    *    },
    *    "rul": [
    *       {
    *          "sel": "...",
    *          "sty": null | { CSS-PROP: VALUE }
    *       },
    *       ...
    *    ]
    * }
    * 
    */
   let jsonCss4 = new Lazy(() => loadJsonResource('res/cosmetics/css4.json'));

   let chainCache = new Map;


   async function collectCss4Rules(hostname, excludeGeneric) {
      let enabledFilters = await chrome.declarativeNetRequest.getEnabledRulesets();
      let res = await jsonCss4;

      let C = makeIncExcCounter('rul');

      for (let fid of enabledFilters) {
         for (let node of nodeChain(res['fids'][fid], hostname)) {
            if (excludeGeneric && node === res['fids'][fid]) {
               continue;
            }

            C.process(node);
         }
      }

      let rules = [];

      for (let num of C.refs()) {
         if (!chainCache.has(num)) {
            chainCache.set(num, compileSelector(res['rul'][num].sel));
         }

         rules.push({
            sel: res['rul'][num].sel,
            chain: chainCache.get(num),
            style: res['rul'][num].sty ?? {display: 'none'}
         });
      }

      return rules;
   }


   async function collectScript(hostname) {
      return [
         ...await scriptPieces(hostname),
         ...await scriptletPieces(hostname),
      ].join('\n\n');
   }


   /**
    * {
    *    "fids": {
    *       "1001": DOMAIN_TREE,
    *       ...
    *    },
    *    "script": ["...", ...]
    * }
    * 
    */
   let jsonScript = new Lazy(() => loadJsonResource('res/cosmetics/script.json'));


   async function scriptPieces(hostname) {
      let enabledFilters = await chrome.declarativeNetRequest.getEnabledRulesets();
      let res = await jsonScript;

      let C = makeIncExcCounter('scr');

      for (let fid of enabledFilters) {
         for (let node of nodeChain(res['fids'][fid], hostname)) {
            C.process(node);
         }
      }

      return Array.from(C.refs(), num => res['script'][num]);
   }


   /**
    * {
    *    "tree": DOMAIN_TREE,
    *    "scriptlet": [
    *       {
    *          "name": "...",
    *          "args": ["arg", ...]
    *       },
    *       ...
    *    ]
    * }
    * 
    */
   let jsonScriptlet = new Lazy(() => loadJsonResource('res/cosmetics/scriptlet.json'));


   let scriptlets = new Lazy(() => 
      loadTextResource('res/cosmetics/scriptlets.txt').then(parseScriptlets)
   );


   async function scriptletPieces(hostname) {
      let pieces = [];

      for (let invoke of await applicableScriptlets(hostname)) {
         pieces.push(await renderScriptletBody(invoke));
      }

      return pieces;
   }


   async function applicableScriptlets(hostname) {
      let res = await jsonScriptlet;
      let C = makeIncExcCounter('scr');

      for (let node of nodeChain(res['tree'], hostname)) {
         C.process(node);
      }

      return Array.from(C.refs(), n => res['scriptlet'][n]);
   }


   async function renderScriptletBody({name, args}) {
      let template = (await scriptlets).get(name + '.js');

      if (!template) {
         return null;
      }

      return template.replace(/\{\{(\d+)\}\}/g, (all, num) => {
         num = Number(num);

         if (1 <= num && num <= args.length) {
            return args[num - 1];
         }
         else {
            return all;
         }
      })
   }


   function parseScriptlets(text) {
      const reNonEmptyLine = /\S/;

      function isNonEmptyLine(line) {
         return reNonEmptyLine.test(line);
      }

      function isCommentLine(line) {
         return line.startsWith('#');
      }

      function isMeaningfulLine(line) {
         return isNonEmptyLine(line) && !isCommentLine(line);
      }

      function isMeaninglessLine(line) {
         return !isMeaningfulLine(line);
      }

      function skipUntil(pred) {
         while (i < lines.length && !pred(lines[i])) {
            i++;
         }
      }

      let
         lines = text.split(/\r?\n/),
         i = 0,
         resources = new Map();

      for (;;) {
         skipUntil(isMeaningfulLine);
         if (i === lines.length) {
            break;
         }

         let fields = lines[i].trim().split(/\s+/);
         if (fields.length !== 2) {
            skipUntil(isMeaninglessLine);
            continue;
         }

         let [name, mime] = fields;
         if (mime !== 'application/javascript') {
            skipUntil(isMeaninglessLine);
            continue;
         }

         let j = i + 1;
         skipUntil(isMeaninglessLine);

         let template = lines.slice(j, i).join('\n');
         resources.set(name, template);
      }

      return resources;
   }

   async function csGetCss4Rules(urlo) {
      let enabled = await isEnabledFor(urlo);

      if (!enabled) {
         return null;
      }

      let excludeGeneric = await shouldExcludeGeneric(urlo);
      let rules = await collectCss4Rules(urlo.hostname, excludeGeneric);

      return {
        css4Rules: rules
      };
   }

   initializeStorageCache({
      persisted: ['numBlockedRequests', 'hardWhitelistTree']
   });


   chrome.action.setBadgeBackgroundColor({
      color: [96, 96, 96, 1]
   });


   chrome.runtime.onInstalled.addListener(async (details) => {

      if (details.reason !== 'install' && details.reason !== 'update') {
         return;
      }

      if (details.reason === 'update') {

         if (chronoVersion(details.previousVersion, '0.1')) {
            // If version is 0.1 or below, we need first to clear the storage
            await chrome.storage.local.clear();
         }
      }

      await chrome.declarativeNetRequest.setExtensionActionOptions({
         displayActionCountAsBadgeText: true
      });

      let hardTree = await loadHardWhitelistTree();

      await save({
         hardWhitelistTree: hardTree
      });

      await effectuateSoftWhitelist(await Storage.softWhitelistTree);
   });


   chrome.webRequest.onErrorOccurred.addListener(
      async (details) => {
         if (details.error.includes("net::ERR_BLOCKED_BY_CLIENT")) {
            save({
               numBlockedRequests: await Storage.numBlockedRequests + 1
            });
         }
      },
      {
         urls: ["*://*/*"]
      }
   );


   chrome.webNavigation.onCommitted.addListener(async (details) => {
      if (details.parentFrameId !== -1 || !reHttp.test(details.url)) {
         return;
      }

      resetCache();

      let urlo = new URL(details.url);

      let enabled = await refreshTabIcon({
         tabId: details.tabId,
         urlo: urlo,
      });   

      if (!enabled) {
         return;
      }

      let injectionTarget = {
         tabId: details.tabId,
         frameIds: [details.frameId]
      };
      

      let excludeGeneric = await shouldExcludeGeneric(urlo);
      let [css, script] = await Promise.all([
         collectCss(urlo.hostname, excludeGeneric),
         collectScript(urlo.hostname)
      ]);

      try {
         await injectJs1002(injectionTarget);

         await Promise.all([
            chrome.scripting.insertCSS({
               target: injectionTarget,
               css: css,
            }),

            chrome.scripting.executeScript({
               target: injectionTarget,
               world: 'MAIN',
               func: (script) => {
                  try {
                     Function('', script).call();
                  }
                  catch (e) {
                  }
               },
               args: [script],
               injectImmediately: false
            })
         ]);
      }
      catch (e) {
      }
   });


   async function injectJs1002(injectionTarget) {
      let fids = await chrome.declarativeNetRequest.getEnabledRulesets();

      if (fids.includes('1002')) {
         await chrome.scripting.executeScript({
            target: injectionTarget,
            files: ['res/cosmetics/1002-inject.js'],
            world: 'MAIN',
            injectImmediately: true
         });
      }
   }


   chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      let urlo = new URL(sender.url);

      switch (message.message) {
      case 'get-css4-rules':
         csGetCss4Rules(urlo).then(sendResponse);
         break;

      case 'get-blocked-report':
         break;

      default:
         return false;
      }

      return true;
   });

})();
