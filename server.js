// ============================================================
//  단어 텔레파시 게임 서버
//  - Express : 정적 파일(public/index.html) 서빙
//  - Socket.IO : 두 플레이어 간 실시간 통신
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// 시간 설정 (테스트할 때 환경변수로 줄일 수 있음)
const ROUND_TIME = Number(process.env.ROUND_TIME) || 5000;   // 단어 입력 시간
const REVEAL_TIME = Number(process.env.REVEAL_TIME) || 5000; // 공개 + 생각 시간
const MATCH_DELAY = Number(process.env.MATCH_DELAY) || 2500; // 매칭 연출 시간

let waitingPlayer = null;      // 매칭 대기 중인 소켓 (한 명만 대기)
const games = new Map();       // roomId -> 게임 상태

// 단어 비교용 정규화: 앞뒤 공백 제거, 소문자화, 내부 공백 제거
function normalize(word) {
  return String(word || '').trim().toLowerCase().replace(/\s+/g, '');
}

io.on('connection', (socket) => {
  // ---------- 매칭 대기열 참가 ----------
  socket.on('join_queue', (nickname) => {
    if (socket.data.roomId) return; // 이미 게임 중이면 무시
    socket.data.nickname = String(nickname || '익명').trim().slice(0, 12) || '익명';

    if (waitingPlayer && waitingPlayer.connected && waitingPlayer.id !== socket.id) {
      const p1 = waitingPlayer;
      waitingPlayer = null;
      startGame(p1, socket);
    } else {
      waitingPlayer = socket;
      socket.emit('waiting');
    }
  });

  // ---------- 단어 제출 ----------
  socket.on('submit_word', (word) => {
    const game = games.get(socket.data.roomId);
    if (!game || game.phase !== 'input') return;          // 입력 시간이 아니면 무시
    if (game.words[socket.id] !== undefined) return;      // 중복 제출 방지

    game.words[socket.id] = String(word || '').trim().slice(0, 20);
    socket.to(game.roomId).emit('opponent_submitted');    // 상대에게 "제출 완료" 알림

    // 둘 다 제출했으면 타이머를 기다리지 않고 바로 공개
    if (Object.keys(game.words).length === 2) {
      clearTimeout(game.timer);
      endRound(game);
    }
  });

  // ---------- 연결 종료 ----------
  socket.on('disconnect', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;

    const game = games.get(socket.data.roomId);
    if (game) {
      clearTimeout(game.timer);
      socket.to(game.roomId).emit('opponent_left');
      cleanupGame(game);
    }
  });
});

// ---------- 게임 시작 ----------
function startGame(p1, p2) {
  const roomId = `room-${p1.id}-${p2.id}`;
  [p1, p2].forEach((p) => {
    p.join(roomId);
    p.data.roomId = roomId;
  });

  const game = { roomId, players: [p1, p2], round: 0, phase: 'idle', words: {}, timer: null };
  games.set(roomId, game);

  p1.emit('matched', { opponent: p2.data.nickname });
  p2.emit('matched', { opponent: p1.data.nickname });

  game.timer = setTimeout(() => startRound(game), MATCH_DELAY);
}

// ---------- 라운드 시작 (단어 입력 단계) ----------
function startRound(game) {
  if (!games.has(game.roomId)) return;
  game.round += 1;
  game.phase = 'input';
  game.words = {};

  io.to(game.roomId).emit('round_start', { round: game.round, time: ROUND_TIME });

  // 네트워크 지연을 고려해 300ms 여유를 두고 라운드 종료
  game.timer = setTimeout(() => endRound(game), ROUND_TIME + 300);
}

// ---------- 라운드 종료 (공개 단계) ----------
function endRound(game) {
  if (!games.has(game.roomId) || game.phase !== 'input') return;
  game.phase = 'reveal';

  const [p1, p2] = game.players;
  const w1 = game.words[p1.id] ?? '';
  const w2 = game.words[p2.id] ?? '';

  // 둘 다 빈 단어가 아니고, 정규화한 결과가 같으면 일치!
  const matched = normalize(w1) !== '' && normalize(w1) === normalize(w2);

  p1.emit('reveal', { mine: w1, theirs: w2, matched, round: game.round, time: REVEAL_TIME });
  p2.emit('reveal', { mine: w2, theirs: w1, matched, round: game.round, time: REVEAL_TIME });

  if (matched) {
    io.to(game.roomId).emit('game_over', { rounds: game.round, word: w1.trim() });
    cleanupGame(game);
  } else {
    game.timer = setTimeout(() => startRound(game), REVEAL_TIME);
  }
}

// ---------- 게임 정리 ----------
function cleanupGame(game) {
  clearTimeout(game.timer);
  games.delete(game.roomId);
  game.players.forEach((p) => {
    p.data.roomId = null;
    p.leave(game.roomId);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`서버 실행 중 → http://localhost:${PORT}`);
});
