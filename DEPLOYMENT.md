# 배포/인프라 구축 기록

`claude` 계정(sudo 권한 없음) 위에 web(Nginx, 11000) / was(Spring Boot, 11001) 분리 구조를 만들고,
GitHub Actions self-hosted runner로 CI/CD까지 연결한 전체 과정 기록. 새로 서버를 세팅하거나
장애 복구 시 참고용 런북(runbook).

## 아키텍처

```
Internet/LAN
     │
     ▼
Nginx :11000  ──/ ───────────────► /home/claude/starter/frontend/dist (정적 파일)
              ──/api/* ──────────► 127.0.0.1:11001 (Spring Boot, proxy_pass)
                                        │
                                        ▼
                          systemd --user: starter-backend.service
                          (java -jar /home/claude/starter/app.jar)
```

- GitHub Actions는 **self-hosted runner**로 이 서버 자체에서 실행된다(공인 IP, SSH 키 secret 불필요).
- `claude` 계정은 sudo 권한이 없다. Nginx만 시스템 패키지라 sudo 세션에서 설치했고,
  나머지(Java/Maven/Node/systemd 서비스/GitHub runner)는 전부 계정 안에서 sudo 없이 설치했다.

## 1. 계정 내 설치 (sudo 불필요)

### 1-1. SDKMAN + Java 21 + Maven

```bash
curl -s "https://get.sdkman.io" | bash
source ~/.sdkman/bin/sdkman-init.sh
sdk install java 21.0.4-tem
sdk install maven
```

### 1-2. Node.js

nvm으로 이미 설치되어 있음 (v22.23.2, `~/.nvm/versions/node/v22.23.2/bin`).

### 1-3. 백엔드 systemd --user 서비스

```bash
mkdir -p ~/.config/systemd/user
cp deploy/starter-backend.service ~/.config/systemd/user/
export XDG_RUNTIME_DIR=/run/user/$(id -u)   # 없으면 "Failed to connect to bus" 에러
systemctl --user daemon-reload
systemctl --user enable starter-backend
```

`deploy/starter-backend.service`:

```ini
[Unit]
Description=Starter Backend (Spring Boot)
After=network.target

[Service]
ExecStart=/home/claude/.sdkman/candidates/java/current/bin/java -jar /home/claude/starter/app.jar
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

## 2. sudo가 필요한 시스템 설정

아래는 sudo 권한이 있는 별도 세션에서 실행한 명령들. `claude` 계정에서는 직접 실행 불가.

### 2-1. lingering 활성화 (로그아웃 후에도 user systemd 서비스 유지)

```bash
sudo loginctl enable-linger claude
```

### 2-2. Nginx 설치

```bash
sudo dnf install -y nginx
```

### 2-3. Nginx 설정 배포

```bash
sudo cp deploy/nginx-starter.conf /etc/nginx/conf.d/starter.conf
sudo nginx -t
sudo systemctl enable --now nginx
```

⚠️ **함정**: 이 시스템은 80번 포트가 이미 다른 프로세스에 점유되어 있어서, `nginx.conf`의 기본
`server { listen 80; }` 블록 때문에 `bind() to 0.0.0.0:80 failed (Address already in use)`로
nginx 기동이 실패했다. 우리 서비스는 80포트가 필요 없으므로 `/etc/nginx/nginx.conf`에서 기본
80포트 server 블록을 제거해서 해결(원본은 `nginx.conf.bak`으로 백업). 이후 `systemctl restart nginx`.

### 2-4. SELinux 컨텍스트

```bash
sudo semanage fcontext -a -t httpd_sys_content_t "/home/claude/starter/frontend/dist(/.*)?"
sudo restorecon -Rv /home/claude/starter/frontend/dist
sudo setsebool -P httpd_can_network_connect 1
```

이 시스템은 SELinux가 `Enforcing` 모드이고, `policycoreutils-python-utils`는 이미 설치되어 있었다.

sudo 불필요 (같이 진행):

```bash
chmod o+x /home/claude /home/claude/starter /home/claude/starter/frontend
```

⚠️ **함정**: `semanage fcontext` 규칙은 `frontend/dist` 경로 패턴에만 등록되어 있다. 배포 스크립트가
`dist_new`로 새로 받은 뒤 `dist`로 `mv`(atomic swap)하는데, `mv`는 원래 라벨(`user_home_t`)을
유지해버려서 매 배포마다 nginx가 403을 낸다. → 배포 스크립트에서 swap 직후
`restorecon -Rv ~/starter/frontend/dist`를 실행해서 해결(이 명령은 이미 등록된 fcontext 규칙
범위 내 relabel이라 **sudo 없이 claude 계정으로 실행 가능**).

### 2-5. sudoers (nginx reload만 무암호 허용)

```bash
sudo visudo -f /etc/sudoers.d/starter-nginx
```

내용:

```
claude ALL=(ALL) NOPASSWD: /usr/sbin/nginx -s reload
```

⚠️ **함정**: 이 시스템은 nginx 바이너리가 `/usr/bin/nginx`가 아니라 `/usr/sbin/nginx`에 있다
(`rpm -ql nginx`로 확인). 처음에 `/usr/bin/nginx`로 등록했다가 `sudo: a password is required`
에러가 나서 경로를 고쳤다.

검증:

```bash
sudo -n /usr/sbin/nginx -s reload   # 비밀번호 없이 성공해야 함
```

### 2-6. 방화벽

```bash
sudo firewall-cmd --permanent --add-port=11000/tcp
sudo firewall-cmd --reload
```

11001(백엔드)은 열지 않는다 — nginx를 통해서만 접근.

## 3. Git / GitHub

```bash
cd ~/starter
git init
git config user.name "claude"
git config user.email "orange121591@gmail.com"
git add .
git commit -m "Initial scaffold: web(11000)+was(11001), Nginx"
git branch -M main
git remote add origin https://github.com/jjh1215/starter.git
git push -u origin main
```

GitHub CLI(`gh`)는 `jjh1215` 계정으로 이미 인증되어 있어 `gh auth setup-git`으로 push용 자격증명을
연결했다.

## 4. GitHub Actions self-hosted runner

이 서버의 IP가 전부 사설 대역(`192.168.x.x`, `172.17.x.x`)이라 GitHub 클라우드 러너가 SSH로
직접 접속할 수 없다. 공인 IP/포트포워딩을 확보하거나 SSH 개인키를 GitHub Secret에 올리는 대신,
**이 서버 자체를 self-hosted runner로 등록**해서 아웃바운드 연결만으로 배포가 되게 했다.
외부에 아무것도 노출하지 않는다.

### 4-1. 러너 등록

```bash
# 등록 토큰 발급 (gh CLI, repo write 권한 필요)
TOKEN=$(gh api -X POST repos/jjh1215/starter/actions/runners/registration-token --jq '.token')

mkdir -p ~/actions-runner && cd ~/actions-runner
curl -o actions-runner-linux-x64-2.336.0.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.336.0/actions-runner-linux-x64-2.336.0.tar.gz
tar xzf actions-runner-linux-x64-2.336.0.tar.gz

./config.sh --url https://github.com/jjh1215/starter --token "$TOKEN" \
  --unattended --name claude-starter-runner --work _work \
  --labels self-hosted,linux,x64,claude
```

### 4-2. systemd --user 서비스로 상시 실행

`actions-runner`에 동봉된 `svc.sh`는 시스템 systemd(root) 전용이라 sudo 없는 이 계정에서는
쓸 수 없다. 대신 백엔드와 같은 방식으로 user 서비스를 직접 만들었다.

`deploy/starter-runner.service`:

```ini
[Unit]
Description=GitHub Actions self-hosted runner (starter)
After=network.target

[Service]
WorkingDirectory=/home/claude/actions-runner
Environment=PATH=/home/claude/.sdkman/candidates/java/current/bin:/home/claude/.sdkman/candidates/maven/current/bin:/home/claude/.nvm/versions/node/v22.23.2/bin:/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin
ExecStart=/home/claude/actions-runner/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
cp deploy/starter-runner.service ~/.config/systemd/user/
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user daemon-reload
systemctl --user enable --now starter-runner
```

⚠️ **함정**: 러너 서비스는 비대화형 셸로 실행되므로 `.bashrc`의 nvm/sdkman init 스크립트가 로드되지
않는다. `npm: command not found`, `mvn: command not found` 에러가 나서, 서비스 파일 자체에
`Environment=PATH=...`로 java/maven/node 경로를 명시해서 해결했다. 새 툴체인을 추가하면 이 PATH도
같이 갱신해야 한다.

등록 확인:

```bash
gh api repos/jjh1215/starter/actions/runners --jq '.runners[] | {name, status, busy}'
```

## 5. CI/CD 파이프라인 (`.github/workflows/deploy.yml`)

`main` 브랜치에 push되면 자동 실행:

1. **build-backend** / **build-frontend** — self-hosted 러너에서 병렬로 각각
   `mvn -B -DskipTests package`, `npm ci && npm run build` 실행 후 `actions/upload-artifact`로 보관
2. **deploy** (두 빌드 완료 후):
   - jar를 `~/starter/app.jar`로 교체 → `systemctl --user restart starter-backend`
   - frontend는 `~/starter/frontend/dist_new`에 새로 받은 뒤 `dist`와 원자적으로 교체(swap)
   - `restorecon -Rv ~/starter/frontend/dist`로 SELinux 라벨 복구
   - `sudo /usr/sbin/nginx -s reload` (NOPASSWD 규칙으로 비밀번호 없이 실행됨)

Actions secrets는 사용하지 않는다 (self-hosted라 SSH/SCP 자체가 없음).

## 6. 로컬 빌드 & 수동 배포 (CI 없이 직접 할 때)

```bash
source ~/.sdkman/bin/sdkman-init.sh
export XDG_RUNTIME_DIR=/run/user/$(id -u)

# 백엔드
cd ~/starter/backend && mvn -B -DskipTests package
cp target/app.jar ~/starter/app.jar
systemctl --user restart starter-backend

# 프론트엔드
cd ~/starter/frontend && npm ci && npm run build
rm -rf ~/starter/frontend/dist_new && mkdir -p ~/starter/frontend/dist_new
cp -r dist/. ~/starter/frontend/dist_new/
rm -rf ~/starter/frontend/dist_old
mv ~/starter/frontend/dist ~/starter/frontend/dist_old 2>/dev/null || true
mv ~/starter/frontend/dist_new ~/starter/frontend/dist
rm -rf ~/starter/frontend/dist_old
restorecon -Rv ~/starter/frontend/dist
sudo -n /usr/sbin/nginx -s reload
```

## 7. 상태 확인 명령

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status starter-backend --no-pager
systemctl --user status starter-runner --no-pager

curl -s http://127.0.0.1:11000/            # 프론트엔드 (200 기대)
curl -s http://127.0.0.1:11000/api/hello   # nginx → 백엔드 프록시 (JSON 기대)
curl -s http://127.0.0.1:11000/api/health  # {"status":"UP"} 기대

gh run list --repo jjh1215/starter --limit 5
gh api repos/jjh1215/starter/actions/runners --jq '.runners[] | {name, status, busy}'
```

## 참고

- `CLAUDE.md` — Claude Code가 이 저장소에서 작업할 때 자동으로 참고하는 요약 컨텍스트(제약사항,
  함정 요약). 이 문서(`DEPLOYMENT.md`)는 사람이 읽는 상세 런북이고, 서로 겹치는 내용이 있다.
