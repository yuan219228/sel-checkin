/**
 * SEL 情緒充電站 - Apps Script 後端（v3：整合版）
 *
 * 這個版本把「網頁」和「資料庫」合併在同一個 Apps Script 專案裡：
 * - doGet 會依網址參數決定要顯示「情緒打卡頁」還是「後台管理頁」
 * - 網頁裡的 JavaScript 改用 google.script.run 跟這支程式溝通
 *   （Google 官方提供的管道，專門給「網頁、後端在同一專案」的情況用，
 *    不會遇到瀏覽器的跨網域限制）
 *
 * 部署後只有「一個網址」：
 *   .../exec         → 情緒打卡頁（同仁填寫用，預設首頁）
 *   .../exec?page=admin → 後台管理頁（承辦人員用；?page=dashboard 也可以）
 *
 * Apps Script 專案裡的 HTML 檔名必須是 index、dashboard（不含 .html）
 */

var SHEET_SUBMIT = '打卡紀錄';
var SHEET_GIFT    = '禮物狀態';

var SUBMIT_HEADERS = ['timestamp','name','unit','title','staffId','email',
  'moodBefore','intensityBefore','bodySignals','stressors','reframe',
  'intensityAfter','delta','moodChange','valence','feedback'];

var GIFT_HEADERS = ['staffId','name','unit','status','notebookStatus','updatedAt'];

// ---------------- 網頁路由 ----------------
function doGet(e){
  var page = (e && e.parameter && e.parameter.page) || 'checkin';
  if(page === 'admin' || page === 'dashboard'){
    return HtmlService.createHtmlOutputFromFile('dashboard')
      .setTitle('SEL 情緒充電站｜後台管理')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('SEL 情緒充電站')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ---------------- 給網頁呼叫的函式（google.script.run） ----------------

// 情緒打卡頁送出資料
function submitCheckin(data){
  var staffId = normId_(data.staffId);
  var shS = getSheet_(SHEET_SUBMIT, SUBMIT_HEADERS);
  shS.appendRow([
    data.timestamp || new Date().toISOString(),
    data.name || '',
    data.unit || '',
    data.title || '',
    staffId,
    data.email || '',
    data.moodBefore || '',
    data.intensityBefore || '',
    joinIfArray_(data.bodySignals),
    joinIfArray_(data.stressors),
    data.reframe || '',
    data.intensityAfter || '',
    data.delta || '',
    data.moodChange || '',
    data.valence || '',
    data.feedback || ''
  ]);
  ensureGiftRow_(staffId, data.name, data.unit);
  return {ok:true};
}

// 後台／打卡頁查詢用：回傳所有資料
function getData(){
  var shS = getSheet_(SHEET_SUBMIT, SUBMIT_HEADERS);
  var shG = getSheet_(SHEET_GIFT, GIFT_HEADERS);

  var submissions = sheetToObjects_(shS).map(function(r){ r.staffId = normId_(r.staffId); return r; });
  var dailyCheckins = submissions.map(function(r){ return { staffId:r.staffId, date: dateOnly_(r.timestamp) }; });

  var giftRows = sheetToObjects_(shG);
  var giftStatus = giftRows.map(function(r){
    return { staffId:normId_(r.staffId), name:r.name, unit:r.unit, status:r.status, updatedAt:r.updatedAt };
  });
  var notebookStatus = giftRows.map(function(r){
    return { staffId:normId_(r.staffId), name:r.name, unit:r.unit, status:r.notebookStatus, updatedAt:r.updatedAt };
  });

  return { submissions:submissions, giftStatus:giftStatus, dailyCheckins:dailyCheckins, notebookStatus:notebookStatus };
}

// 後台：切換「筆」的領取狀態
function setGiftStatus(staffId, status, name, unit){
  staffId = normId_(staffId);
  var shG = getSheet_(SHEET_GIFT, GIFT_HEADERS);
  var rowIdx = findGiftRow_(shG, staffId);
  if(rowIdx === -1){ ensureGiftRow_(staffId, name, unit); rowIdx = findGiftRow_(shG, staffId); }
  shG.getRange(rowIdx, 4).setValue(status);
  shG.getRange(rowIdx, 6).setValue(new Date().toISOString());
  if(name) shG.getRange(rowIdx, 2).setValue(name);
  if(unit) shG.getRange(rowIdx, 3).setValue(unit);
  return {ok:true};
}

// 後台：切換「筆記本」的領取狀態
function setNotebookStatus(staffId, status, name, unit){
  staffId = normId_(staffId);
  var shG = getSheet_(SHEET_GIFT, GIFT_HEADERS);
  var rowIdx = findGiftRow_(shG, staffId);
  if(rowIdx === -1){ ensureGiftRow_(staffId, name, unit); rowIdx = findGiftRow_(shG, staffId); }
  shG.getRange(rowIdx, 5).setValue(status);
  shG.getRange(rowIdx, 6).setValue(new Date().toISOString());
  if(name) shG.getRange(rowIdx, 2).setValue(name);
  if(unit) shG.getRange(rowIdx, 3).setValue(unit);
  return {ok:true};
}

// ---------------- 內部工具函式 ----------------
function getSheet_(name, headers){
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
  }
  return sh;
}

function sheetToObjects_(sh){
  var values = sh.getDataRange().getValues();
  if(values.length < 2) return [];
  var headers = values[0];
  var out = [];
  for(var i=1;i<values.length;i++){
    var row = values[i];
    if(row.join('') === '') continue;
    var obj = {};
    for(var j=0;j<headers.length;j++){ obj[headers[j]] = row[j]; }
    out.push(obj);
  }
  return out;
}

function joinIfArray_(v){
  if(Array.isArray(v)) return v.join('、');
  return v == null ? '' : v;
}

function normId_(v){
  return String(v || '').trim().toUpperCase();
}

function dateOnly_(ts){
  var d = (ts instanceof Date) ? ts : new Date(ts);
  if(isNaN(d.getTime())) return '';
  var tz = Session.getScriptTimeZone() || 'Asia/Taipei';
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function findGiftRow_(sh, staffId){
  var values = sh.getDataRange().getValues();
  for(var i=1;i<values.length;i++){ if(normId_(values[i][0]) === staffId) return i+1; }
  return -1;
}

function ensureGiftRow_(staffId, name, unit){
  if(!staffId) return;
  var sh = getSheet_(SHEET_GIFT, GIFT_HEADERS);
  if(findGiftRow_(sh, staffId) !== -1) return;
  sh.appendRow([staffId, name || '', unit || '', '', '', new Date().toISOString()]);
}
