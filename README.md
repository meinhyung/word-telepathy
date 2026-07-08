# 단어 텔레파시

온라인에서 만난 두 사람이 같은 단어를 말할 때까지 라운드를 반복하는 웹 게임.

## 기능

- **랜덤 매칭** — 대기열에서 자동으로 상대와 연결
- **방 만들기** — 4자리 초대 코드로 친구와 플레이
- **한 번 더 투표** — 승리 후 둘 다 동의하면 같은 파트너와 연속 게임
- **최근 5게임 기록** — 메인 화면에 표시 (브라우저에 저장됨)
- 게임 중 나가기, 상대 이탈 처리, 미입력 라운드 처리

## 로컬 실행

```bash
npm install
npm start
```

브라우저에서 `http://localhost:3000` 접속. 혼자 테스트하려면 탭 2개를 열면 됩니다.

## 온라인 배포 (Render 무료 플랜)

### 1. GitHub에 코드 올리기

1. https://github.com 회원가입 후 새 저장소(Repository) 생성 — 이름 예: `word-telepathy`, Public 선택
2. 이 폴더에서 터미널을 열고:

```bash
git init
git add .
git commit -m "첫 배포"
git branch -M main
git remote add origin https://github.com/내아이디/word-telepathy.git
git push -u origin main
```

(`node_modules`는 `.gitignore`에 있어서 자동으로 제외됩니다)

### 2. Render에 연결하기

1. https://render.com 접속 → **GitHub 계정으로 가입** (신용카드 불필요)
2. 대시보드에서 **New → Web Service** 클릭
3. 방금 만든 `word-telepathy` 저장소 선택
4. 설정 확인:
   - Language: `Node`
   - Build Command: `npm install` (자동 입력됨)
   - Start Command: `npm start` (자동 입력됨)
   - Instance Type: **Free** 선택
5. **Deploy Web Service** 클릭

몇 분 후 `https://word-telepathy-xxxx.onrender.com` 같은 주소가 생기고,
이 주소를 누구에게나 공유하면 바로 게임할 수 있습니다.

### 무료 플랜 주의사항

- 15분간 접속이 없으면 서버가 잠들고, 다음 접속 시 깨어나는 데 30초~1분 걸립니다
- 서버가 재시작되면 진행 중이던 게임은 끊깁니다 (기록은 각자 브라우저에 저장되어 안전)

### 코드 수정 후 재배포

```bash
git add .
git commit -m "수정 내용"
git push
```

push하면 Render가 자동으로 새 버전을 배포합니다.

## 시간 설정 바꾸기

환경변수로 조절 (밀리초 단위):

```bash
ROUND_TIME=8000 REVEAL_TIME=6000 npm start
```

Render에서는 대시보드의 Environment 탭에서 같은 이름으로 추가하면 됩니다.

## 구조

| 파일 | 역할 |
|---|---|
| `server.js` | 매칭, 초대 코드 방, 라운드 타이머, 일치 판정, 투표 (Socket.IO) |
| `public/index.html` | 게임 화면 전체 (HTML + CSS + JS) |
