import { useState } from "react";
import Landing from "./Landing.jsx";
import ErpApp from "./ErpApp.jsx";

export default function App() {
  const [view, setView] = useState("landing");

  if (view === "erp") {
    return (
      <div>
        {/* 홈 복귀 버튼 */}
        <div style={{position:"fixed",bottom:20,right:16,zIndex:1000}}>
          <button onClick={()=>setView("landing")} style={{
            padding:"10px 16px",borderRadius:12,
            background:"linear-gradient(135deg,#7C3AED,#A855F7)",
            color:"#fff",fontWeight:800,fontSize:12,
            border:"none",cursor:"pointer",
            fontFamily:"'Noto Sans KR',sans-serif",
            boxShadow:"0 4px 20px rgba(124,58,237,.5)",
          }}>
            ← 홈
          </button>
        </div>
        <ErpApp />
      </div>
    );
  }
  return <Landing onStart={()=>setView("erp")} />;
}
