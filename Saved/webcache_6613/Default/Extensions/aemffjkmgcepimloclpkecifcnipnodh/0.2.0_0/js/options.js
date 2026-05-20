(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('[data-i18n]').forEach(function (elt) {
      elt.innerHTML = chrome.i18n.getMessage(elt.dataset.i18n);
    });
  }, {
    once: true
  });

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

  /**
   * Common definitions that all code should have access to.
   */

  const ADLOCK_FILTERS = [
      {
        name: "Russian",
        id: '1001',
      },
      {
        name: "English",
        id: '1002',
      },
      {
        name: "Spanish/Portuguese",
        id: '1005',
      },
      {
        name: "German",
        id: '1006',
      },
      {
        name: "Dutch",
        id: '1008',
      },
      {
        name: "Czech/Slovak",
        id: '1105',
      },
      {
        name: "French",
        id: '1113',
      },
      {
        name: "Polish",
        id: '1216',
      },
      // {
      //   name: "Scriptlet filter list",
      //   id: '1900',
      // },
      // Not used
      // {
      //   name: "Spyware",
      //   id: '1003'
      // },
      // {
      //   name: "Social media",
      //   id: '1004'
      // }
    ];
    ADLOCK_FILTERS.map(info => info.id);

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

  const RulePriority = {
     GENERIC_BLOCK: 1,
     GENERIC_ALLOW: 2,
     SPECIFIC_BLOCK: 3,
     ALLOW: 4,
     WHITELIST: 5,
  };

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

  const reHostname = /^[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*$/;
  const REDIRECT_PRO_URL ="https://adlock.com/chrome-vs-windows/?acr=NTQSguI";

  let filterListWrap = document.querySelector('.filter-list-wrap ol');
  let navWrapHeader = document.querySelector('header');
  let navTabs = Array.from(document.querySelectorAll('.nav-item'));
  let sections = Array.from(document.querySelectorAll('section'));


  initializeStorageCache({
     shared: ['softWhitelist', 'softWhitelistTree']
  });


  // Navigation between sections
  navWrapHeader.addEventListener('click', function (e) {
     if (!e.target.matches('.nav-item')) {
        return;
     }
     
     let selectedTab = e.target;
     let selectedSectionName = selectedTab.dataset.target;

     for (let navTab of navTabs) {
        if (navTab === selectedTab) {
           navTab.classList.add('active');
        }
        else {
           navTab.classList.remove('active');
        }
     }

     for (let section of sections) {
        if (section.dataset.section === selectedSectionName) {
           section.classList.add('active');
        }
        else {
           section.classList.remove('active');
        }
     }
  });


  // Section: Filters
  async function initializeFiltersSection() {
     let enabledFilters = await chrome.declarativeNetRequest.getEnabledRulesets();

     filterListWrap.appendChild(makeProFilterElem('1003'));
     filterListWrap.appendChild(makeProFilterElem('1004'));

     for (let {id: fid} of ADLOCK_FILTERS) {
        filterListWrap.appendChild(
           makeFilterElem({
              fid,
              isEnabled: enabledFilters.includes(fid)
           })
        );
     }
  }


  function makeFilterElem({fid, isEnabled}) {
     let name = chrome.i18n.getMessage("filter_name_" + fid);
     let desc = chrome.i18n.getMessage("filter_desc_" + fid);

     let html = `
      <li class="filter" data-fid="${fid}">
         <div class="filter-info-desc clip-nowrap-text-container">
            <p class="filter-name">${name}</p>
            <p class="filter-url">${desc}</p>
         </div>
         <div class="flex-stretcher"></div>
         <input class="filter-info-checked" type="checkbox" ${isEnabled ? 'checked' : ''}>
      </li>
   `;

     return document.createRange().createContextualFragment(html.trim()).firstChild;
  }


  function makeProFilterElem(fid) {
     let name = chrome.i18n.getMessage("filter_name_" + fid);
     let desc = chrome.i18n.getMessage("filter_desc_" + fid);

     let html = `
      <li class="filter">
         <div class="filter-info-desc clip-nowrap-text-container">
            <p class="filter-name" >${name}</p>
            <p class="filter-url">${desc}</p>
         </div>
         <div class="flex-stretcher"></div>
         <a class="filter-info-pro" href="https://adlock.com/?source=ext_ch_fltr" target="_blank">PRO</a>
      </li>
   `;

     return document.createRange().createContextualFragment(html.trim()).firstChild;
  }


  // Turn on/off a filter
  filterListWrap.addEventListener('change', function (e) {
     if (!e.target.matches('.filter-info-checked')) {
        return;
     }

     if (e.target.matches('.filter-info-pro')) {
        window.location = REDIRECT_PRO_URL;
        return;
     }

     let checkbox = e.target;
     let filter = checkbox.closest('.filter');
     let fid = filter.dataset.fid;

     if (checkbox.checked) {
        chrome.declarativeNetRequest.updateEnabledRulesets({
           enableRulesetIds: [fid]
        });
     }
     else {
        chrome.declarativeNetRequest.updateEnabledRulesets({
           disableRulesetIds: [fid]
        });
     }
  });


  // Section: Whitelist
  let filterWhitelist = document.querySelector('.filter-whitelist');
  let whitelistWrap = document.querySelector('.whitelist-wrap ul');
  let excForm = document.querySelector('.exc-form');
  let excOpenFormBtn = document.querySelector('.exc-open-form-btn');
  let excUrl = document.querySelector('.exc-url');


  async function initializeWhitelistSection() {
     await rebuildWhitelist();
  }


  async function rebuildWhitelist() {
     whitelistWrap.innerHTML = '';

     for (let white of await Storage.softWhitelist) {
        whitelistWrap.appendChild(makeWhiteElem(white));
     }

     rehighlightWhitelist();
  }


  function makeWhiteElem(white) {
     let html = `
         <li class="white-list-item">
            <p>${new Date(white.date).toLocaleString()}</p>
            <h4 class="hostname">${white.domain}</h4>
            <div class="cross-white-list"></div>
         </li>
   `;

     return document.createRange().createContextualFragment(html.trim()).firstChild;
  }


  async function rehighlightWhitelist() {
     let val = filterWhitelist.value;
     let whitelist = await Storage.softWhitelist;

     for (let i = 0; i < whitelist.length; i += 1) {
        let
           domain = whitelist[i].domain,
           elem = whitelistWrap.children[i];

        if (domain.toUpperCase().indexOf(val.toUpperCase()) !== -1) {
           elem.classList.remove('invisible');
           if (val !== '') {
              elem.children[1].innerHTML = domain.replace(val,
                 `<span class="sch-result-highlight">${val}</span>`
              );
           }
        }
        else {
           elem.classList.add('invisible');
        }

        if (val === '') {
           elem.children[1].innerHTML = domain;
        }
     }
  }


  addWatcherFor([Storage.softWhitelist], rebuildWhitelist);


  excOpenFormBtn.addEventListener('click', function () {
     this.classList.toggle('active');
     excForm.classList.toggle('show');
     excUrl.classList.remove('error');
     excUrl.value = '';
     excUrl.focus();
  });


  document.querySelector('.exc-close-form-btn').addEventListener('click', function () {
     excForm.classList.remove('show');
     excOpenFormBtn.classList.remove('active');
  });


  filterWhitelist.addEventListener('input', rehighlightWhitelist);


  excUrl.addEventListener('input', function () {
     if (this.value === '') {
        this.classList.remove('error');
     }
  });


  document.querySelector('.exc-add-btn').addEventListener('click', addWhitelistItem);


  whitelistWrap.addEventListener('click', async function (e) {
     if (!e.target.matches('.cross-white-list')) {
        return;
     }

     let cross = e.target;
     let item = cross.closest('.white-list-item');
     let hostname = item.querySelector('.hostname').innerText;

     await unwhitelist(hostname);
  });


  excUrl.addEventListener('keydown', function (e) {
     switch (e.key) {
        case 'Enter':
           addWhitelistItem();
           break;

        case 'Escape':
           closeWhitelistUrlForm();
           break;
     }
  });


  async function addWhitelistItem() {
     excUrl.classList.remove('error');

     let url = excUrl.value;

     if (url === '') {
        return;
     }

     let hostname;

     if (reHostname.test(url)) {
        hostname = url;
     }
     else {
        try {
           hostname = new URL(url).hostname;
        }
        catch (e) {
           excUrl.classList.add('error');
           excUrl.focus();
           return;
        }
     }

     await whitelist(hostname);

     closeWhitelistUrlForm();
  }


  function closeWhitelistUrlForm() {
     excUrl.value = '';
     excForm.classList.remove('show');
     excOpenFormBtn.classList.remove('active');   
  }


  // Page initialization
  (async function () {
     await Promise.all([
        initializeFiltersSection(),
        initializeWhitelistSection(),
     ]);
  })();

})();
