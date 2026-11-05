// Shared score labels for the phone scorer and the server-side Watch response.
// This is presentation only; scoring rules remain in the existing engine.
((root) => {
  function point(a,b,side){
    if(a>=3&&b>=3){if(a===b)return 'Deuce';if(side==='a'&&a>b)return 'Ad';if(side==='b'&&b>a)return 'Ad';return '40'}
    return ['0','15','30','40'][side==='a'?a:b]||'40';
  }
  function parts(m){return m.is_tiebreak?[String(m.tiebreak_a),String(m.tiebreak_b)]:[point(m.point_a,m.point_b,'a'),point(m.point_a,m.point_b,'b')]}
  root.BPTScoreFormat=Object.freeze({point,parts});
})(globalThis);
