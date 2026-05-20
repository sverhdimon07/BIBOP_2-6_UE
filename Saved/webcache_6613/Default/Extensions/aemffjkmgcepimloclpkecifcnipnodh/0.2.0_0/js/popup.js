(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-i18n]').forEach(function (elt) {
      elt.innerHTML = chrome.i18n.getMessage(elt.dataset.i18n);
    });
  }, {
    once: true
  });

  /** @module General-purpose utilities */


  function getOwn(obj, prop) {
     return Object.hasOwn(obj, prop) ? obj[prop] : undefined;
  }


  /**
   * Works only for objects with null or standard prototype
   */
  function isEmptyObj(obj) {
     for (let prop in obj) {
        return false;
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


  function removeAll(tree, domain) {
     let parts = domain.split('.');
     let removed = [];

     // @return: false | matched: chain
     function go(node, k) {
        if (node === undefined) {
           return;
        }

        if (isIncluded(node)) {
           delete node[soFar];
           removed.push(parts.slice(k).join('.'));
        }

        if (k === 0) {
           return;
        }

        let subnode = getOwn(node, parts[k - 1]);

        if (subnode !== undefined) {
           go(subnode, k - 1);

           if (isEmptyObj(subnode)) {
              delete node[parts[k - 1]];
           }
        }
     }

     go(tree, parts.length);

     return removed;
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


  function addWatcherFor(keys, watcher) {
     let shouldCall = false;

     for (let key of keys) {
        shouldCall ||= key.addWatcher(watcher);
     }

     if (shouldCall) {
        watcher();
     }
  }

  const RulePriority = {
     GENERIC_BLOCK: 1,
     GENERIC_ALLOW: 2,
     SPECIFIC_BLOCK: 3,
     ALLOW: 4,
     WHITELIST: 5,
  };

  async function isHostnameWhitelisted(hostname) {
     return (
        covers(await Storage.hardWhitelistTree, hostname) ? 'hard' :
        covers(await Storage.softWhitelistTree, hostname)
     );
  }


  async function whitelist(hostname) {
     let list = await Storage.softWhitelist;
     let tree = await Storage.softWhitelistTree;

     let {needSave, needUpdate} = add(tree, hostname);

     if (needSave) {
        list.push({
           domain: hostname,
           date: new Date().toISOString()
        });

        save({
           softWhitelist: list,
           softWhitelistTree: tree,
        });
     }

     if (needUpdate) {
        await effectuateSoftWhitelist(tree);
     }
  }


  async function unwhitelist(hostname) {
     let list = await Storage.softWhitelist;
     let tree = await Storage.softWhitelistTree;

     let removed = removeAll(tree, hostname);

     if (removed.length === 0) {
        return;
     }

     for (let rem of removed) {
        list.splice(list.findIndex(({domain}) => domain === rem), 1);
     }

     save({
        softWhitelist: list,
        softWhitelistTree: tree,
     });

     await effectuateSoftWhitelist(tree);
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


  async function refreshAllTabIcons() {
     let tabs = await chrome.tabs.query({});
     let ps = [];

     for (let tab of tabs) {
        ps.push(
           refreshTabIcon({
              tabId: tab.id,
              urlo: new URL(tab.url),
           })
        );
     }

     await Promise.all(ps);
  }


  async function getCurrentTab() {
     let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

     return tab;
  }


  /**
   * Subscribe to eventName on object and return promise that resolves when the event fires.
   * The event handler is attached with {once: true}.
   * @return Promise
   */
  function eventFired(object, eventName) {
     return new Promise((resolve) => {
        object.addEventListener(eventName, resolve, {once: true});
     });
  }

  const GLOBAL_WHITELIST_RULE_ID = 1002;


  async function setGlobalState(on) {
     save({isOn: on});

     let spec = {
        removeRuleIds: [GLOBAL_WHITELIST_RULE_ID]
     };

     if (!on) {
        spec.addRules = [{
           id: GLOBAL_WHITELIST_RULE_ID,
           priority: RulePriority.WHITELIST,
           condition: {
              resourceTypes: ['main_frame', 'sub_frame']
           },
           action: {
              type: 'allowAllRequests'
           }
        }];
     }

     await chrome.declarativeNetRequest.updateDynamicRules(spec);
     await refreshAllTabIcons();
  }

  initializeStorageCache({
     shared: ['numBlockedRequests']
  });


  Promise.all([getInitialState(), eventFired(document, 'DOMContentLoaded')])
     .then(([state]) => onReady(state));


  async function getInitialState() {
     let tab = await getCurrentTab();
     let isApplicable = reHttp.test(tab.url);
     let hostname = (new URL(tab.url)).hostname;

     return {
        numTotalBlocked: await Storage.numBlockedRequests,
        numTabBlocked: await getTabBlocked(tab.id),
        tabId: tab.id,
        tabHostname: hostname,
        isOn: await Storage.isOn,
        isApplicable,
        isWhitelisted: isApplicable && await isHostnameWhitelisted(hostname),
        isRated: await Storage.isRated,
     };
  }


  async function getTabBlocked(tabId) {
     let text = await chrome.action.getBadgeText({tabId});

     return text && Number(text) || 0;
  }


  const SUPPORT_LINK = "https://adlock.com/support/";

  const STORE_LINKS = {
     chrome: "https://chrome.google.com/webstore/detail/adlock-ad-blocker/aemffjkmgcepimloclpkecifcnipnodh/",
     opera: "https://addons.opera.com/extensions/details/adlock-2/",
     edge: "https://microsoftedge.microsoft.com/addons/detail/coanhlhpoegcbpjapcaedenbdcajnijo"
  };


  function onReady(state) {
     console.log("state:", state);

     let {
        numTotalBlocked,
        numTabBlocked,
        tabId,
        tabHostname,
        isOn,
        isApplicable,
        isWhitelisted,  // false, true, 'hard'
        isRated
     } = state;

     let
        eltTotalBlocked = document.getElementById('total-blocked'),
        eltTabBlocked = document.getElementById('tab-blocked'),
        eltWhitelist = document.getElementById('whitelist'),
        eltGlobalSwitch = document.getElementById('global-switch'),
        eltRateStars = document.getElementById('rate-stars'),
        eltRateLink = document.getElementById('rate-link');

     function refreshBlockedCounts() {
        eltTotalBlocked.innerText = formatNumCount(numTotalBlocked);
        eltTabBlocked.innerText = numTabBlocked;
     }

     function refreshView() {
        eltWhitelist.disabled = !isOn || !isApplicable || isWhitelisted === 'hard';
        eltWhitelist.checked = !isWhitelisted;

        if (!isOn || !isApplicable) {
           document.body.classList.add('off');
        }
        else {
           document.body.classList.remove('off');
        }

        if (isWhitelisted === 'hard') {
           document.body.classList.add('hard-whitelisted');
        }

        if (isOn) {
           eltGlobalSwitch.innerText = chrome.i18n.getMessage('adlock_turn_off');
           eltGlobalSwitch.classList.remove('off');
        }
        else {
           eltGlobalSwitch.innerText = chrome.i18n.getMessage('adlock_turn_on');
           eltGlobalSwitch.classList.add('off');
        }

        if (isRated) {
           document.body.classList.add('is-rated');
        }
        else {
           document.body.classList.remove('is-rated');
        }

        refreshBlockedCounts();
     }

     async function reloadTab() {
        await chrome.scripting.executeScript({
           target: {tabId},
           func: () => {
              window.location.reload();
           }
        });
     }

     eltWhitelist.addEventListener('change', async () => {
        isWhitelisted = !isWhitelisted;

        if (isWhitelisted) {
           numTabBlocked = 0;
        }

        refreshView();

        if (isWhitelisted) {
           await whitelist(tabHostname);
        }
        else {
           await unwhitelist(tabHostname);
        }

        await reloadTab();
     });

     eltGlobalSwitch.addEventListener('click', async () => {
        isOn = !isOn;
        
        numTabBlocked = 0;
        refreshView();

        await setGlobalState(isOn);
        await reloadTab();
     });

     eltRateStars.addEventListener('click', async (e) => {
        if (isRated) {
           return;
        }

        let elt = e.target.closest('.rate__star');

        save({isRated: true});

        let rate = Number(elt.dataset.rate);
        let link = rate <= 3 ? SUPPORT_LINK : STORE_LINKS['chrome'];
        
        eltRateLink.setAttribute('href', link);
        eltRateLink.click();

        isRated = true;
        refreshView();
     });

     addWatcherFor([Storage.numBlockedRequests], async () => {
        numTotalBlocked = await Storage.numBlockedRequests;
        numTabBlocked = await getTabBlocked(tabId);

        refreshBlockedCounts();
     });

     chrome.webNavigation.onCommitted.addListener(async (details) => {
        if (!(details.tabId === tabId && details.parentFrameId === -1)) {
           return;
        }

        numTabBlocked = await getTabBlocked(tabId);
        refreshBlockedCounts();
     });

     // Add 5 stars by cloning the template
     let tmpl = document.getElementById('template-star');

     for (let i = 5; i >= 1; i -= 1) {
        let [star] = tmpl.content.cloneNode(true).children;
        star.dataset['rate'] = i;
        tmpl.parentNode.appendChild(star);
     }

     // Inject the link to options page (cannot have static link in HTML, it is dynamic)
     document.getElementById('settings-link').href = chrome.runtime.getURL('options.html');

     refreshView();

     // This is just to suppress transition temporarily, when the popup shows up.
     // See https://stackoverflow.com/questions/11131875/
     eltWhitelist.classList.add('notransition');
     eltWhitelist.offsetHeight;
     eltWhitelist.classList.remove('notransition');
  }


  function formatNumCount(count) {
     let unit = 1000,
        i = 0;

     if (count <= unit)
        return count;

     while (count > unit) {
        i += 1;
        count = count / unit;
     }
     let pre = "kMGTPE".charAt(i - 1);

     if (count < 10) {
        (count.toFixed(1).slice(-1) === '0') ? count = Math.floor(count) : count = count.toFixed(1);
     }
     else {
        count = Math.floor(count);
     }

     return count + pre;
  }

})();
