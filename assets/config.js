/*
 * 프론트엔드 배포 설정
 *  - GAS_URL     : Apps Script 웹 앱 URL (…/exec). 비워 두면 브라우저 안에서 동작하는 "데모 모드"로 실행된다.
 *  - EVENT_TOKEN : 구글시트 config 탭의 event_token 값과 같아야 한다.
 *  - EVENT_CODE  : 같은 기기에서 행사별 진행 상태를 구분하는 키 (config 탭 event_code 와 맞추는 것을 권장)
 */
window.APP_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbzpV6m5Fzhn_kHeeTKNfjhOZvyg8ItGSw4nYwRysoiLG4QaFpvFSis-ssa4vO8AFF8xcw/exec',
  EVENT_TOKEN: 'fede5a2146a54f84b0b21e8e676ac240',
  EVENT_CODE: 'FAIR26',
  FRONTEND_VERSION: '1.2.0'
};
