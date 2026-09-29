const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";
const INDEX_FILE = path.join(__dirname, "public", "index.html");
const MAX_PLAYERS = 60;
const QUESTION_SECONDS = 20;

// 15 questions: 10 core + 5 harder/coding-style questions.
const QUESTIONS = [
  { q: "Which keyword is used to define a function in Python?", a: ["func", "define", "def", "function"], c: 2 },
  { q: "Which symbol starts a comment in Python?", a: ["//", "#", "<!--", "**"], c: 1 },
  { q: "What is the output of print(2 + 3 * 2)?", a: ["10", "12", "8", "7"], c: 2 },
  { q: "Which data type stores True or False?", a: ["String", "Boolean", "Float", "List"], c: 1 },
  { q: "Which brackets create a Python list?", a: ["()", "{}", "[]", "< >"], c: 2 },
  { q: "Which function returns the number of items in a list?", a: ["size()", "count()", "len()", "length()"], c: 2 },
  { q: "What does IDE stand for?", a: ["Integrated Development Environment", "Internet Data Engine", "Internal Design Editor", "Integrated Digital Extension"], c: 0 },
  { q: "Which loop is commonly used to iterate over a sequence?", a: ["repeat", "for", "loop", "iterate"], c: 1 },
  { q: "Which operator is used for exponentiation?", a: ["^", "//", "**", "%%"], c: 2 },
  { q: "What is the result of type(10)?", a: ["str", "float", "int", "number"], c: 2 },
  { q: "CODING • What is printed by: x=[1,2,3]; print(x[-1])?", a: ["1", "2", "3", "Error"], c: 2 },
  { q: "CODING • What is the output of: print([i*i for i in range(3)])?", a: ["[0,1,2]", "[1,2,3]", "[0,1,4]", "[1,4,9]"], c: 2 },
  { q: "HARD • What does this print? d={'a':1,'b':2}; print(d.get('c',0))", a: ["None", "0", "c", "KeyError"], c: 1 },
  { q: "HARD • Which statement is true about Python tuples?", a: ["They are always sorted", "They are mutable", "They are immutable", "They store only numbers"], c: 2 },
  { q: "HARD • What is the output? a=[1,2]; b=a; b.append(3); print(a)", a: ["[1,2]", "[1,2,3]", "[3]", "Error"], c: 1 }
];

const rooms = new Map();

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}
function broadcast(room, message) {
  if (room.host) send(room.host.ws, message);
  for (const p of room.players.values()) send(p.ws, message);
}
function makeRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}
function playerList(room, includeScores) {
  return [...room.players.values()].map(p => includeScores
    ? {id:p.id,name:p.name,score:p.score}
    : {id:p.id,name:p.name});
}
function sendState(room) {
  send(room.host.ws, {type:"state", players:playerList(room,true), started:room.started, questionIndex:room.questionIndex, maxPlayers:MAX_PLAYERS, chatEnabled:room.chatEnabled});
  for (const p of room.players.values()) {
    send(p.ws, {type:"state", players:playerList(room,false), started:room.started, questionIndex:room.questionIndex, maxPlayers:MAX_PLAYERS, chatEnabled:room.chatEnabled});
  }
}
function sendQuestion(room) {
  clearTimeout(room.questionTimer);
  room.questionIndex++;
  room.answers.clear();
  if (room.questionIndex >= QUESTIONS.length) return finishQuiz(room);
  const q = QUESTIONS[room.questionIndex];
  broadcast(room,{type:"question",index:room.questionIndex,total:QUESTIONS.length,question:q.q,answers:q.a,seconds:QUESTION_SECONDS});
  room.questionTimer=setTimeout(()=>sendQuestion(room),QUESTION_SECONDS*1000);
}
function finishQuiz(room) {
  clearTimeout(room.questionTimer);
  room.started=false;
  const leaderboard=[...room.players.values()].map(p=>({name:p.name,score:p.score})).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));
  // Host sees the complete leaderboard. Each student gets only their own result + full answer key.
  send(room.host.ws,{type:"finished",host:true,leaderboard,answerKey:QUESTIONS.map(q=>({q:q.q,answers:q.a,correct:q.c}))});
  for(const p of room.players.values()){
    send(p.ws,{type:"finished",host:false,score:p.score,total:QUESTIONS.length,answerKey:QUESTIONS.map((q,i)=>({q:q.q,answers:q.a,correct:q.c,selected:p.history[i] ?? null}))});
  }
}
function startQuiz(room){
  if(room.started)return;
  room.started=true;room.questionIndex=-1;room.answers.clear();
  for(const p of room.players.values()){p.score=0;p.history=[];}
  broadcast(room,{type:"countdown",seconds:3});
  setTimeout(()=>{if(rooms.get(room.code)===room&&room.started)sendQuestion(room);},3000);
}

const server=http.createServer((req,res)=>{
  if(req.method==="GET"&&(req.url==="/"||req.url==="/index.html")){
    try{const html=fs.readFileSync(INDEX_FILE);res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(html);}
    catch(e){res.writeHead(500);res.end("Quiz page could not be loaded.");}
    return;
  }
  res.writeHead(404);res.end("Not found");
});
const wss=new WebSocket.Server({server});

wss.on("connection",ws=>{
  ws.id=Math.random().toString(36).slice(2);ws.roomCode=null;ws.role=null;
  ws.on("message",raw=>{
    let m;try{m=JSON.parse(raw.toString())}catch{return send(ws,{type:"error",message:"Invalid message."})}
    if(m.type==="create"){
      const name=String(m.name||"").trim().slice(0,24);if(!name)return send(ws,{type:"error",message:"Enter a host name."});
      const code=makeRoomCode();const room={code,host:{id:ws.id,name,ws},players:new Map(),started:false,questionIndex:-1,questionTimer:null,answers:new Set(),chatEnabled:true,createdAt:Date.now()};
      rooms.set(code,room);ws.roomCode=code;ws.role="host";
      send(ws,{type:"created",code,maxPlayers:MAX_PLAYERS});sendState(room);return;
    }
    if(m.type==="join"){
      const code=String(m.code||"").trim().toUpperCase();const name=String(m.name||"").trim().slice(0,24);const room=rooms.get(code);
      if(!name)return send(ws,{type:"error",message:"Enter your name."});
      if(!room)return send(ws,{type:"error",message:"Room not found."});
      if(room.started)return send(ws,{type:"error",message:"This quiz has already started."});
      if(room.players.size>=MAX_PLAYERS)return send(ws,{type:"error",message:"Room is full (60 players max)."});
      room.players.set(ws.id,{id:ws.id,name,ws,score:0,history:[]});ws.roomCode=code;ws.role="player";
      send(ws,{type:"joined",code});sendState(room);return;
    }
    const room=rooms.get(ws.roomCode);if(!room)return send(ws,{type:"error",message:"You are not in a room."});
    if(m.type==="start"){
      if(ws.role!=="host")return send(ws,{type:"error",message:"Only the host can start the quiz."});
      if(room.players.size===0)return send(ws,{type:"error",message:"Wait for at least one player to join."});
      startQuiz(room);return;
    }
    if(m.type==="answer"){
      if(ws.role!=="player"||!room.started||room.questionIndex<0||room.questionIndex>=QUESTIONS.length||room.answers.has(ws.id))return;
      const p=room.players.get(ws.id),q=QUESTIONS[room.questionIndex];if(!p)return;
      const selected=Number(m.answer);p.history[room.questionIndex]=Number.isInteger(selected)?selected:null;room.answers.add(ws.id);
      const correct=selected===q.c;if(correct)p.score++;
      send(ws,{type:"answerResult",correct,score:p.score});sendState(room);return;
    }
    if(m.type==="chat"){
      if(!room.chatEnabled)return;
      const text=String(m.text||"").trim().slice(0,180);if(!text)return;
      const name=ws.role==="host"?room.host.name:(room.players.get(ws.id)?.name||"Player");
      broadcast(room,{type:"chat",name,text,host:ws.role==="host",ts:Date.now()});return;
    }
    if(m.type==="chatToggle"){
      if(ws.role!=="host")return send(ws,{type:"error",message:"Only the host can control chat."});
      room.chatEnabled=!!m.enabled;broadcast(room,{type:"chatStatus",enabled:room.chatEnabled});sendState(room);return;
    }
  });
  ws.on("close",()=>{
    const code=ws.roomCode;if(!code)return;const room=rooms.get(code);if(!room)return;
    if(ws.role==="host"){
      clearTimeout(room.questionTimer);broadcast(room,{type:"error",message:"The host left. This room is closed."});rooms.delete(code);return;
    }
    room.players.delete(ws.id);sendState(room);
  });
});
server.listen(PORT,HOST,()=>console.log(`Python Cinematic Quiz Arena running on port ${PORT}`));
