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
 * - 對外（doPost）只開放「送出打卡」、「查自己的累積天數」和「今天要不要問小回顧」，
 *   讀不到任何人的資料。
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
  'intensityAfter','delta','moodChange','valence','feedback','challenge','challengeAnswer'];

// 今日 SEL 小挑戰：累積第 1～5 天各一題情境題（之後輪流），只收 D1–D5、A–D
var CHALLENGE_IDS = ['D1','D2','D3','D4','D5'];
var CHALLENGE_ANSWERS = ['A','B','C','D'];

var GIFT_HEADERS = ['staffId','name','unit','status','notebookStatus','updatedAt'];

// 日常運用小回顧：第 1 天前測、第 3 天後測、第 5 天再測（每個階段每人只問一次）
var SHEET_REFLECT = '日常運用';
var REFLECT_HEADERS = ['timestamp','staffId','name','unit','title','phase',
  'q1_察覺情緒','q2_身體訊號','q3_說出情緒','q4_主動調節','q5_因應方式','q6_先停下來','q7_經驗分享',
  'q8_問同事還好嗎','q9_注意同事情緒','q10_跨職類道謝','q11_先聽完再回應','q13_冷靜評估','q12_決策步驟'];
var REFLECT_PHASES = ['前測','第3天','第5天'];
var FREQ4 = ['0 次','1–2 次','3–5 次','6 次以上'];
var SCALE5 = ['從來沒有','偶爾','一半一半','常常','幾乎每次'];
// 每題在哪些階段問（沒列的三個階段都問）
var REFLECT_ASKED = {
  q3: ['第3天'], q5: ['第3天'], q6: ['第3天'], q7: ['第3天'],
  q8: ['前測','第5天'], q9: ['前測','第5天'], q10: ['前測','第5天'], q11: ['前測','第5天'], q13: ['前測','第5天'],
  q12: ['第5天']
};
// 只收這些選項，避免亂填的資料混進統計
var REFLECT_OPTIONS = {
  q1: SCALE5,
  q2: SCALE5,
  q3: ['比較難','差不多','比較容易'],
  q4: ['沒有','1 次','2–3 次','4 次以上'],
  q5: ['深呼吸','暫時離開現場','跟同事或朋友聊聊','寫下來','轉移注意力','先忍著','其他'],
  q6: ['沒有遇到這種情況','有遇到，但沒停下來','有停下來'],
  q8: FREQ4, q9: FREQ4, q10: FREQ4, q11: SCALE5, q13: SCALE5,
  q12: ['先蒐集更多資訊','請教同事或主管','考慮病人或家屬的意願','確認規範或流程','想過可能的後果','事後反思結果','以上都沒有，當下就決定了']
};

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
  getProgress: getProgress,
  getReflectionPhase: getReflectionPhase
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
  var ch = data.challenge || {};
  var chOk = CHALLENGE_IDS.indexOf(ch.id) >= 0 && CHALLENGE_ANSWERS.indexOf(ch.answer) >= 0;
  appendByHeaders_(getSheet_(SHEET_SUBMIT, SUBMIT_HEADERS), SUBMIT_HEADERS, {
    timestamp: new Date().toISOString(),
    name: data.name || '',
    unit: data.unit || '',
    title: data.title || '',
    staffId: staffId,
    email: data.email || '',
    moodBefore: data.moodBefore || '',
    intensityBefore: data.intensityBefore || '',
    bodySignals: joinIfArray_(data.bodySignals),
    stressors: joinIfArray_(data.stressors),
    reframe: data.reframe || '',
    intensityAfter: data.intensityAfter || '',
    delta: data.delta || '',
    moodChange: data.moodChange || '',
    valence: data.valence || '',
    feedback: data.feedback || '',
    challenge: chOk ? ch.id : '',
    challengeAnswer: chOk ? ch.answer : ''
  });
  ensureGiftRow_(staffId, data.name, data.unit);
  if(data.reflection) saveReflection_(staffId, data, data.reflection);
  SpreadsheetApp.flush();
  return {ok:true};
}

// 打卡頁查詢用：今天要不要先問「小回顧」（哪一個階段），以及今天是累積第幾天
// 只回傳階段名稱和天數，不會透露任何人的回答
function getReflectionPhase(staffId){
  staffId = normId_(staffId);
  if(!staffId) return {phase:'', day:0};
  var today = dateOnly_(new Date());
  var days = {};
  sheetToObjects_(getSheet_(SHEET_SUBMIT, SUBMIT_HEADERS)).forEach(function(r){
    if(normId_(r.staffId) !== staffId) return;
    var d = dateOnly_(r.timestamp);
    if(d && d !== today) days[d] = true;
  });
  var before = Object.keys(days).length;   // 今天以前打過幾天
  var day = before + 1;                    // 今天是累積第幾天（決定今日 SEL 小挑戰）
  var done = reflectionPhasesOf_(staffId);
  if(!done['前測'] && before < 2) return {phase:'前測', day:day};      // 第 1 天（剛上線時第 2 天的人也補一次）
  if(!done['第3天'] && before >= 2 && before < 4) return {phase:'第3天', day:day};
  if(!done['第5天'] && before >= 4) return {phase:'第5天', day:day};
  return {phase:'', day:day};
}

function reflectionPhasesOf_(staffId){
  var done = {};
  sheetToObjects_(getSheet_(SHEET_REFLECT, REFLECT_HEADERS)).forEach(function(r){
    if(normId_(r.staffId) === staffId) done[r.phase] = true;
  });
  return done;
}

function saveReflection_(staffId, data, rf){
  if(!staffId || REFLECT_PHASES.indexOf(rf.phase) === -1) return;
  if(reflectionPhasesOf_(staffId)[rf.phase]) return;          // 同一階段已經回答過
  var asked = function(key){ var ph = REFLECT_ASKED[key]; return !ph || ph.indexOf(rf.phase) >= 0; };
  var pick = function(key){ var v = rf[key]; return asked(key) && REFLECT_OPTIONS[key].indexOf(v) >= 0 ? v : ''; };
  var multi = function(key){
    if(!asked(key)) return '';
    return (Array.isArray(rf[key]) ? rf[key] : []).filter(function(v){ return REFLECT_OPTIONS[key].indexOf(v) >= 0; }).join('、');
  };
  appendByHeaders_(getSheet_(SHEET_REFLECT, REFLECT_HEADERS), REFLECT_HEADERS, {
    'timestamp': new Date().toISOString(), 'staffId': staffId, 'name': data.name || '', 'unit': data.unit || '',
    'title': data.title || '', 'phase': rf.phase,
    'q1_察覺情緒': pick('q1'), 'q2_身體訊號': pick('q2'), 'q3_說出情緒': pick('q3'), 'q4_主動調節': pick('q4'),
    'q5_因應方式': multi('q5'), 'q6_先停下來': pick('q6'),
    'q7_經驗分享': asked('q7') ? String(rf.q7 || '').slice(0, 1000) : '',
    'q8_問同事還好嗎': pick('q8'), 'q9_注意同事情緒': pick('q9'), 'q10_跨職類道謝': pick('q10'),
    'q11_先聽完再回應': pick('q11'), 'q13_冷靜評估': pick('q13'), 'q12_決策步驟': multi('q12')
  });
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

  var reflections = sheetToObjects_(getSheet_(SHEET_REFLECT, REFLECT_HEADERS)).map(function(r){
    return { timestamp:r.timestamp, staffId:normId_(r.staffId), name:r.name, unit:r.unit, phase:r.phase,
      q1:r['q1_察覺情緒'], q2:r['q2_身體訊號'], q3:r['q3_說出情緒'], q4:r['q4_主動調節'],
      q5:r['q5_因應方式'], q6:r['q6_先停下來'], q7:r['q7_經驗分享'],
      q8:r['q8_問同事還好嗎'], q9:r['q9_注意同事情緒'], q10:r['q10_跨職類道謝'], q11:r['q11_先聽完再回應'],
      q13:r['q13_冷靜評估'], q12:r['q12_決策步驟'] };
  });

  return { submissions:submissions, giftStatus:giftStatus, dailyCheckins:dailyCheckins, notebookStatus:notebookStatus, reflections:reflections };
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

// 依「欄位名稱」寫入一列：工作表缺的欄位會自動加在最右邊，舊資料的欄位位置不受影響
function appendByHeaders_(sh, headers, obj){
  var lastCol = Math.max(1, sh.getLastColumn());
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function(h){ return String(h); });
  headers.forEach(function(h){
    if(head.indexOf(h) === -1){ head.push(h); sh.getRange(1, head.length).setValue(h); }
  });
  sh.appendRow(head.map(function(h){ return safeCell_(obj.hasOwnProperty(h) ? obj[h] : ''); }));
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
