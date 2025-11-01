import app from './app';
import config from './config';

// 환경설정에서 지정한 포트로 HTTP 서버를 실행
const PORT = config.PORT;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
