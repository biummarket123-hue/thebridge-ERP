import { Component } from "react";
import { S } from "../constants.js";

// 화면 한 칸이 그리다가 터져도 앱 전체가 꺼지지 않게 막는다.
//
// 리액트는 그리는 중에 오류가 나면 화면을 통째로 지운다. 막는 곳이 없으면 헤더도 탭도
// 같이 사라져 빈 화면만 남는다 — 포장 화면의 완료 칸 하나가 터졌는데 포장팀은 아무것도
// 못 누르게 된다(2026-09-28 에 실제로 그랬다). 터진 칸만 안내로 바꾸고 나머지는 살려 둔다.
//
// 색은 테마를 쓰지 않고 직접 적는다. 테마를 읽다가 난 오류일 수도 있어서다.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(`[${this.props.name || "화면"}] 그리는 중 오류:`, error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" style={{margin:"8px 0",padding:"16px 16px 18px",borderRadius:12,border:"2px solid #C05A4A",
        background:"rgba(192,90,74,0.10)",fontFamily:S,lineHeight:1.65}}>
        <div style={{fontSize:15,fontWeight:900,color:"#C05A4A",marginBottom:4}}>
          {this.props.name || "이 화면"}을 표시하지 못했습니다
        </div>
        <div style={{fontSize:12.5,color:"#A89880"}}>
          다른 탭은 그대로 쓸 수 있습니다. 새로고침해도 같으면 관리자에게 아래 내용을 알려 주세요.
        </div>
        <div style={{fontSize:11.5,color:"#A89880",marginTop:8,fontFamily:"monospace",overflowWrap:"anywhere"}}>
          {String(this.state.error?.message || this.state.error)}
        </div>
        <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
          <button onClick={() => this.setState({ error: null })} style={{padding:"9px 14px",borderRadius:8,cursor:"pointer",
            fontFamily:S,fontSize:12.5,fontWeight:800,border:"1px solid #C05A4A",background:"transparent",color:"#C05A4A"}}>
            다시 시도
          </button>
          <button onClick={() => window.location.reload()} style={{padding:"9px 14px",borderRadius:8,cursor:"pointer",
            fontFamily:S,fontSize:12.5,fontWeight:800,border:"none",background:"#C05A4A",color:"#fff"}}>
            새로고침
          </button>
        </div>
      </div>
    );
  }
}
