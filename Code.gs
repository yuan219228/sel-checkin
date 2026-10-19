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
 *
 * 資料寫到哪個試算表：
 * - 如果這支程式是從試算表「擴充功能 → Apps Script」建立的（綁定試算表），不用設定。
 * - 如果是獨立的 Apps Script 專案，請把試算表網址中 /d/ 和 /edit 之間那串 ID
 *   填到下面的 SPREADSHEET_ID，否則資料無處可寫。
 *
 * 網頁放在 GitHub Pages 時，網頁會改用 fetch 呼叫 doPost，
 * 部署時「誰可以存取」必須選「所有人」。
 *
 * 資料保護：
 * - 對外（doPost）只開放「送出打卡」和「查自己的累積天數」，讀不到任何人的資料。
 * - 後台（getData、切換領取狀態）只有 ADMIN_EMAILS 裡的帳號、
 *   從 Apps Script 網址（.../exec?page=admin）登入 Google 開啟時才能用。
 */

var SPREADSHEET_ID = '';

// 可以看後台的 Google 帳號；留空 = 只有部署這支程式的帳號本人
var ADMIN_EMAILS = [];

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

// ---------------- 給 GitHub Pages 等外部網頁呼叫（fetch POST） ----------------
// 網頁送來 {fn:'submitCheckin', args:[...]}，回傳 {ok:true, result:...}
// 這裡只放「不會洩漏別人資料」的函式，千萬不要把 getData 加進來
var PUBLIC_FUNCTIONS = {
  submitCheckin: submitCheckin,
  getProgress: getProgress
};

function doPost(e){
  var out;
  try{
    var req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = PUBLIC_FUNCTIONS[req.fn];
    if(!fn) throw new Error('未知的函式：' + req.fn);
    out = {ok:true, result: fn.apply(null, req.args || [])};
  }catch(err){
    console.error(err);
    out = {ok:false, error: String(err && err.message || err)};
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------- 給網頁呼叫的函式（google.script.run） ----------------

// 情緒打卡頁送出資料
function submitCheckin(data){
  data = data || {};
  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // 多人同時送出時排隊，避免列互相覆蓋
  try{
    return submitCheckinLocked_(data);
  }finally{
    lock.releaseLock();
  }
}

function submitCheckinLocked_(data){
  var staffId = normId_(data.staffId);
  var shS = getSheet_(SHEET_SUBMIT, SUBMIT_HEADERS);
  var row = [
    new Date().toISOString(),
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
  ].map(safeCell_);
  shS.appendRow(row);
  ensureGiftRow_(staffId, data.name, data.unit);
  SpreadsheetApp.flush();
  return {ok:true};
}

// 打卡頁查詢用：只回傳這個員工編號累積打卡的天數
function getProgress(staffId){
  staffId = normId_(staffId);
  if(!staffId) return {days:0};
  var shS = getSheet_(SHEET_SUBMIT, SUBMIT_HEADERS);
  var days = {};
  sheetToObjects_(shS).forEach(function(r){
    if(normId_(r.staffId) === staffId) days[dateOnly_(r.timestamp)] = true;
  });
  delete days[''];
  return {days: Object.keys(days).length};
}

// 後台用：回傳所有資料（限管理者）
function getData(){
  requireAdmin_();
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
  requireAdmin_();
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
  requireAdmin_();
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
function requireAdmin_(){
  var me = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  var owner = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  var admins = ADMIN_EMAILS.length
    ? ADMIN_EMAILS.map(function(x){ return String(x).toLowerCase(); })
    : [owner];
  if(!me || admins.indexOf(me) === -1){
    throw new Error('沒有權限：請用管理者的 Google 帳號登入後，從 Apps Script 網址開啟後台');
  }
}

// 擋掉試算表公式注入（例如填入 =IMPORTXML(...)），並限制長度
function safeCell_(v){
  if(typeof v === 'number' || typeof v === 'boolean') return v;
  v = String(v == null ? '' : v).slice(0, 2000);
  if(v !== '' && !isNaN(Number(v))) return v;   // 數字（含負數）照原樣
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function getSpreadsheet_(){
  var id = SPREADSHEET_ID ||
    PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if(id) return SpreadsheetApp.openById(id);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if(!ss) throw new Error('找不到試算表：請在 Code.gs 的 SPREADSHEET_ID 填入試算表 ID');
  return ss;
}

function getSheet_(name, headers){
  var ss = getSpreadsheet_();
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
    for(var j=0;j<headers.length;j++){
      // google.script.run 無法回傳 Date 物件（整包資料會變 null），先轉成字串
      var v = row[j];
      obj[headers[j]] = (v instanceof Date) ? v.toISOString() : v;
    }
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
