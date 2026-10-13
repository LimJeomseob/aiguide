/*
 * mock-gas.js
 * Google Apps Script 런타임(SpreadsheetApp·LockService·CacheService·PropertiesService·
 * Utilities·ContentService)의 최소 모의 구현.
 *  - 브라우저: GAS_URL이 비어 있을 때 "데모 모드"로 gas/Code.js를 그대로 실행한다.
 *  - Node: tests/server.test.js 에서 서버 로직을 검증한다.
 * 실제 운영에는 사용되지 않는다.
 */
(function (root) {
  'use strict';

  function reviveCell(v) {
    if (v && typeof v === 'object' && v.__d) return new Date(v.__d);
    return v;
  }
  function freezeCell(v) {
    if (v instanceof Date) return { __d: v.toISOString() };
    return v === undefined || v === null ? '' : v;
  }

  function pad(n, w) {
    n = String(n);
    while (n.length < (w || 2)) n = '0' + n;
    return n;
  }

  function partsInTz(date, tz) {
    var fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'Asia/Seoul',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    var out = {};
    fmt.formatToParts(date).forEach(function (p) { out[p.type] = p.value; });
    return out;
  }

  function createEnv(opts) {
    opts = opts || {};
    var db = (opts.load && opts.load()) || { sheets: {}, order: [], props: {}, tz: 'Asia/Seoul' };
    var cache = {};

    function persist() { if (opts.save) opts.save(db); }

    // 서식 지정 등 모의 환경에서 의미 없는 메서드는 체이닝 가능한 no-op으로 처리
    function makeNoop(target) {
      var p = new Proxy(target, {
        get: function (t, prop) {
          if (typeof prop === 'symbol') return undefined;
          if (prop in t) {
            var v = t[prop];
            if (typeof v !== 'function') return v;
            return function () {
              var r = v.apply(t, arguments);
              return r === t ? p : r; // 체이닝 시 프록시 유지
            };
          }
          return function () { return p; };
        }
      });
      return p;
    }

    function Sheet(name) {
      var self = {};
      function data() { return db.sheets[name]; }

      self.getName = function () { return name; };
      self.getLastRow = function () {
        var d = data();
        for (var r = d.length - 1; r >= 0; r--) {
          var row = d[r] || [];
          for (var c = 0; c < row.length; c++) {
            if (row[c] !== '' && row[c] !== null && row[c] !== undefined) return r + 1;
          }
        }
        return 0;
      };
      self.getLastColumn = function () {
        var d = data(), max = 0;
        d.forEach(function (row) {
          for (var c = row.length - 1; c >= 0; c--) {
            if (row[c] !== '' && row[c] !== null && row[c] !== undefined) { max = Math.max(max, c + 1); break; }
          }
        });
        return max;
      };
      self.getMaxRows = function () { return Math.max(1000, data().length); };
      self.getRange = function (row, col, nr, nc) {
        if (typeof row === 'string') throw new Error('mock: A1 표기는 지원하지 않습니다');
        return Range(name, row, col, nr || 1, nc || 1);
      };
      self.getDataRange = function () {
        return Range(name, 1, 1, Math.max(1, self.getLastRow()), Math.max(1, self.getLastColumn()));
      };
      self.appendRow = function (values) {
        var r = self.getLastRow() + 1;
        Range(name, r, 1, 1, values.length).setValues([values]);
        return self;
      };
      self.clear = function () { db.sheets[name] = []; persist(); return self; };
      self.clearContents = self.clear;
      self.deleteRows = function (start, count) {
        data().splice(start - 1, count);
        persist();
      };
      return makeNoop(self);
    }

    function Range(sheetName, row, col, nr, nc) {
      var self = {};
      function data() { return db.sheets[sheetName]; }
      function ensure() {
        var d = data();
        while (d.length < row - 1 + nr) d.push([]);
        for (var r = row - 1; r < row - 1 + nr; r++) {
          while (d[r].length < col - 1 + nc) d[r].push('');
        }
      }
      self.getRow = function () { return row; };
      self.getColumn = function () { return col; };
      self.getNumRows = function () { return nr; };
      self.getValues = function () {
        var d = data(), out = [];
        for (var r = 0; r < nr; r++) {
          var src = d[row - 1 + r] || [], line = [];
          for (var c = 0; c < nc; c++) {
            var v = src[col - 1 + c];
            line.push(v === undefined || v === null ? '' : reviveCell(v));
          }
          out.push(line);
        }
        return out;
      };
      self.getValue = function () { return self.getValues()[0][0]; };
      self.getDisplayValues = function () {
        return self.getValues().map(function (line) {
          return line.map(function (v) { return v instanceof Date ? v.toISOString() : String(v); });
        });
      };
      self.setValues = function (values) {
        if (values.length !== nr || values[0].length !== nc) {
          throw new Error('mock: setValues 크기 불일치 (' + values.length + 'x' + values[0].length + ' vs ' + nr + 'x' + nc + ')');
        }
        ensure();
        var d = data();
        for (var r = 0; r < nr; r++) {
          for (var c = 0; c < nc; c++) d[row - 1 + r][col - 1 + c] = freezeCell(values[r][c]);
        }
        persist();
        return self;
      };
      self.setValue = function (v) { return Range(sheetName, row, col, 1, 1).setValues([[v]]); };
      self.setFormula = function (f) { return self.setValue(f); };
      self.clearContent = function () {
        var blank = [];
        for (var r = 0; r < nr; r++) { var l = []; for (var c = 0; c < nc; c++) l.push(''); blank.push(l); }
        return self.setValues(blank);
      };
      self.createTextFinder = function (text) {
        var entire = false;
        var finder = {
          matchEntireCell: function (b) { entire = !!b; return finder; },
          matchCase: function () { return finder; },
          findAll: function () {
            var vals = self.getValues(), hits = [];
            for (var r = 0; r < nr; r++) {
              for (var c = 0; c < nc; c++) {
                var v = vals[r][c];
                var s = v instanceof Date ? v.toISOString() : String(v);
                if (entire ? s === String(text) : s.indexOf(String(text)) >= 0) {
                  hits.push(Range(sheetName, row + r, col + c, 1, 1));
                }
              }
            }
            return hits;
          },
          findNext: function () { var a = finder.findAll(); return a.length ? a[0] : null; }
        };
        return finder;
      };
      return makeNoop(self);
    }

    var spreadsheet = makeNoop({
      getId: function () { return 'mock-spreadsheet'; },
      getName: function () { return '윤리교육 이수 (데모)'; },
      getSheetByName: function (name) { return db.sheets[name] ? Sheet(name) : null; },
      getSheets: function () { return db.order.map(function (n) { return Sheet(n); }); },
      insertSheet: function (name) {
        if (db.sheets[name]) throw new Error('mock: 이미 존재하는 시트 ' + name);
        db.sheets[name] = [];
        db.order.push(name);
        persist();
        return Sheet(name);
      },
      setSpreadsheetTimeZone: function (tz) { db.tz = tz; persist(); },
      getSpreadsheetTimeZone: function () { return db.tz; }
    });

    var env = {
      SpreadsheetApp: {
        getActiveSpreadsheet: function () { return spreadsheet; },
        openById: function () { return spreadsheet; },
        getUi: function () { throw new Error('mock: UI 없음'); }
      },
      LockService: {
        getScriptLock: function () {
          return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {} };
        }
      },
      CacheService: {
        getScriptCache: function () {
          return {
            get: function (k) {
              var e = cache[k];
              if (!e) return null;
              if (e.exp < Date.now()) { delete cache[k]; return null; }
              return e.v;
            },
            put: function (k, v, ttl) { cache[k] = { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }; },
            remove: function (k) { delete cache[k]; }
          };
        }
      },
      PropertiesService: {
        getScriptProperties: function () {
          return {
            getProperty: function (k) { return Object.prototype.hasOwnProperty.call(db.props, k) ? db.props[k] : null; },
            setProperty: function (k, v) { db.props[k] = String(v); persist(); },
            deleteProperty: function (k) { delete db.props[k]; persist(); }
          };
        }
      },
      Session: { getScriptTimeZone: function () { return db.tz || 'Asia/Seoul'; } },
      Utilities: {
        getUuid: function () {
          if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
          return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
            var r = Math.random() * 16 | 0;
            return (ch === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
        },
        formatDate: function (date, tz, fmt) {
          var p = partsInTz(date, tz);
          return fmt
            .replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day)
            .replace('HH', p.hour).replace('mm', p.minute).replace('ss', p.second);
        }
      },
      ContentService: {
        MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
        createTextOutput: function (s) {
          var out = {
            _c: s,
            setMimeType: function () { return out; },
            getContent: function () { return out._c; }
          };
          return out;
        }
      },
      Logger: { log: function () { if (typeof console !== 'undefined') console.log.apply(console, arguments); } },
      __db: db
    };
    return env;
  }

  var api = { createEnv: createEnv, pad: pad };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MockGas = api;
})(typeof window !== 'undefined' ? window : this);
