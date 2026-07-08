// ============================================================
//  단어 텔레파시 게임 서버 v2
//  - 랜덤 매칭 + 초대 코드 방 만들기
//  - 게임 종료 후 "한 번 더" 투표
//  - 게임 중 나가기 처리
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
const ROUND_TIME = Number(process.env.ROUND_TIME) || 8000;   // 단어 입력 시간
const REVEAL_TIME = Number(process.env.REVEAL_TIME) || 5000; // 공개 + 생각 시간
const MATCH_DELAY = Number(process.env.MATCH_DELAY) || 2500; // 매칭/재시작 연출 시간
const VOTE_TIME = Number(process.env.VOTE_TIME) || 30000;    // "한 번 더" 투표 제한 시간

let waitingPlayer = null;       // 랜덤 매칭 대기 중인 소켓 (한 명만 대기)
const openRooms = new Map();    // 초대 코드 -> 호스트 소켓
const games = new Map();        // roomId -> 게임 상태

// 단어 비교용 정규화: 앞뒤 공백 제거, 소문자화, 내부 공백 제거
function normalize(word) {
  return String(word || '').trim().toLowerCase().replace(/\s+/g, '');
}

// 미입력 시 "미입력(전 라운드 단어)" 형식으로 표기. 전 라운드 단어가 없으면 "미입력"만 표기
function formatWord(word, prevWord) {
  if (word) return word;
  if (prevWord) return `미입력(${prevWord})`;
  return '미입력';
}

// 헷갈리는 문자(0/O, 1/I)를 뺀 4자리 초대 코드 생성
function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (openRooms.has(code));
  return code;
}

function cleanNickname(nickname) {
  return String(nickname || '익명').trim().slice(0, 12) || '익명';
}

io.on('connection', (socket) => {
  // ---------- 랜덤 매칭 ----------
  socket.on('join_queue', (nickname) => {
    if (socket.data.roomId) return; // 이미 게임 중이면 무시
    leaveWaitingStates(socket);     // 방을 만들어둔 상태였다면 정리
    socket.data.nickname = cleanNickname(nickname);

    if (waitingPlayer && waitingPlayer.connected && waitingPlayer.id !== socket.id) {
      const p1 = waitingPlayer;
      waitingPlayer = null;
      startGame(p1, socket);
    } else {
      waitingPlayer = socket;
      socket.emit('waiting');
    }
  });

  // ---------- 방 만들기 (초대 코드) ----------
  socket.on('create_room', (nickname) => {
    if (socket.data.roomId) return;
    leaveWaitingStates(socket);
    socket.data.nickname = cleanNickname(nickname);

    const code = makeRoomCode();
    socket.data.hostCode = code;
    openRooms.set(code, socket);
    socket.emit('room_created', { code });
  });

  // ---------- 코드로 참가 ----------
  socket.on('join_room', ({ nickname, code }) => {
    if (socket.data.roomId) return;
    leaveWaitingStates(socket);
    socket.data.nickname = cleanNickname(nickname);

    const host = openRooms.get(String(code || '').trim().toUpperCase());
    if (!host || !host.connected || host.id === socket.id) {
      socket.emit('room_error', { message: '해당 코드의 방을 찾을 수 없어요.' });
      return;
    }
    openRooms.delete(host.data.hostCode);
    host.data.hostCode = null;
    startGame(host, socket);
  });

  // ---------- 대기 취소 (매칭 대기 / 방 만들기 취소) ----------
  socket.on('cancel_waiting', () => leaveWaitingStates(socket));

  // ---------- 단어 제출 ----------
  socket.on('submit_word', (word) => {
    const game = games.get(socket.data.roomId);
    if (!game || game.phase !== 'input') return;          // 입력 시간이 아니면 무시
    if (game.words[socket.id] !== undefined) return;      // 중복 제출 방지

    const trimmed = String(word || '').trim().slice(0, 20);
    const norm = normalize(trimmed);
    if (norm && game.usedWords.has(norm)) {
      // 이 게임에서 이미 나왔던 단어면 거절하고 다시 입력하게 함
      socket.emit('word_rejected', { message: '이미 나온 단어예요. 다른 단어를 입력해주세요.' });
      return;
    }

    game.words[socket.id] = trimmed;
    socket.to(game.roomId).emit('opponent_submitted');    // 상대에게 "제출 완료" 알림

    // 둘 다 제출했으면 타이머를 기다리지 않고 바로 공개
    if (Object.keys(game.words).length === 2) {
      clearTimeout(game.timer);
      endRound(game);
    }
  });

  // ---------- "한 번 더" 투표 ----------
  socket.on('vote_continue', (agree) => {
    const game = games.get(socket.data.roomId);
    if (!game || game.phase !== 'vote') return;
    if (game.votes[socket.id] !== undefined) return;

    game.votes[socket.id] = !!agree;
    socket.to(game.roomId).emit('opponent_voted', { agree: !!agree });

    const votes = Object.values(game.votes);
    if (votes.includes(false)) {
      // 한 명이라도 거절하면 종료
      clearTimeout(game.timer);
      io.to(game.roomId).emit('vote_result', { continue: false, reason: 'declined' });
      cleanupGame(game);
    } else if (votes.length === 2) {
      // 둘 다 동의 → 같은 파트너와 새 게임
      clearTimeout(game.timer);
      game.gamesTogether += 1;
      io.to(game.roomId).emit('vote_result', { continue: true, gamesTogether: game.gamesTogether });
      game.round = 0;
      game.phase = 'idle';
      game.giveupVotes = {};
      game.timer = setTimeout(() => startRound(game), MATCH_DELAY);
    }
  });

  // ---------- 게임 포기 투표 (게임이 매치되기 전, 둘 다 동의해야 종료) ----------
  socket.on('vote_giveup', (agree) => {
    const game = games.get(socket.data.roomId);
    if (!game || !['input', 'reveal'].includes(game.phase)) return;

    if (!agree) {
      // 거절: 진행 중이던 포기 제안을 취소하고 상대에게 알림
      if (Object.keys(game.giveupVotes).length > 0) {
        game.giveupVotes = {};
        socket.to(game.roomId).emit('giveup_declined');
      }
      return;
    }

    if (game.giveupVotes[socket.id]) return; // 이미 제안함
    game.giveupVotes[socket.id] = true;
    socket.to(game.roomId).emit('opponent_giveup_requested');

    const [p1, p2] = game.players;
    if (game.giveupVotes[p1.id] && game.giveupVotes[p2.id]) {
      clearTimeout(game.timer);
      io.to(game.roomId).emit('game_giveup');
      cleanupGame(game);
    }
  });

  // ---------- 게임에서 나가기 (메인으로) ----------
  socket.on('leave_game', () => {
    leaveWaitingStates(socket);
    const game = games.get(socket.data.roomId);
    if (game) {
      clearTimeout(game.timer);
      socket.to(game.roomId).emit('opponent_left');
      cleanupGame(game);
    }
  });

  // ---------- 연결 종료 ----------
  socket.on('disconnect', () => {
    leaveWaitingStates(socket);
    const game = games.get(socket.data.roomId);
    if (game) {
      clearTimeout(game.timer);
      socket.to(game.roomId).emit('opponent_left');
      cleanupGame(game);
    }
  });
});

// 매칭 대기열/만들어둔 방에서 빠져나오기
function leaveWaitingStates(socket) {
  if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
  if (socket.data.hostCode) {
    openRooms.delete(socket.data.hostCode);
    socket.data.hostCode = null;
  }
}

// ---------- 게임 시작 ----------
function startGame(p1, p2) {
  const roomId = `room-${p1.id}-${p2.id}`;
  [p1, p2].forEach((p) => {
    p.join(roomId);
    p.data.roomId = roomId;
  });

  const game = {
    roomId,
    players: [p1, p2],
    round: 0,
    phase: 'idle',
    words: {},
    prevWords: {},      // 직전 라운드에 각자 제출했던 단어 (미입력 표기용)
    usedWords: new Set(), // 이 게임에서 이미 나온 단어 (정규화됨, 재사용 금지용)
    votes: {},
    giveupVotes: {},
    gamesTogether: 1,
    timer: null,
  };
  games.set(roomId, game);

  p1.emit('matched', { opponent: p2.data.nickname });
  p2.emit('matched', { opponent: p1.data.nickname });

  game.timer = setTimeout(() => startRound(game), MATCH_DELAY);
}

// ---------- 라운드 시작 (단어 입력 단계) ----------
function startRound(game) {
  if (!games.has(game.roomId)) return;
  game.prevWords = game.words; // 직전 라운드 단어 스냅샷 (미입력 표기용)
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

  // 미입력이면 전 라운드에 냈던 단어를 괄호 안에 표기
  const display1 = formatWord(w1, game.prevWords[p1.id]);
  const display2 = formatWord(w2, game.prevWords[p2.id]);

  p1.emit('reveal', { mine: display1, theirs: display2, matched, round: game.round, time: REVEAL_TIME });
  p2.emit('reveal', { mine: display2, theirs: display1, matched, round: game.round, time: REVEAL_TIME });

  // 이번 라운드에 나온 단어는 이후 라운드에서 재사용 금지
  const norm1 = normalize(w1);
  const norm2 = normalize(w2);
  if (norm1) game.usedWords.add(norm1);
  if (norm2) game.usedWords.add(norm2);

  if (matched) {
    io.to(game.roomId).emit('game_over', {
      rounds: game.round,
      word: w1.trim(),
      gamesTogether: game.gamesTogether,
    });
    // 바로 정리하지 않고 "한 번 더" 투표 단계로
    game.phase = 'vote';
    game.votes = {};
    game.timer = setTimeout(() => {
      if (!games.has(game.roomId) || game.phase !== 'vote') return;
      io.to(game.roomId).emit('vote_result', { continue: false, reason: 'timeout' });
      cleanupGame(game);
    }, VOTE_TIME);
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
