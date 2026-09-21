import { createRoot } from "react-dom/client";
import Workspace, { State } from "../app/workspace";
import "../app/globals.css";

// Disposable samples, never copied from the local/production database.
const sample: State = {
  activities: [
    {id:"sample-activity",name:"10/24 協會聯誼",date:"2026-10-24",startDate:"2026-08-29",endDate:"2026-11-07",owner:"活動夥伴 A",proxy:"嘉駿",status:"籌備中",type:"會員聯誼",size:"中型",targetAttendance:80,currentMilestone:"完成第二波宣傳並確認場地與餐飲報價",location:"台北市活動空間",teams:["公關行銷","主持","場務"],budget:60000,description:"台北聯誼活動，聚焦活動流程、工作人員協作與現場執行。"},
    {id:"sample-workshop",name:"11/08 GPS 工作坊",date:"2026-11-08",startDate:"2026-09-13",endDate:"2026-11-22",owner:"嘉駿",proxy:"活動夥伴 A",status:"規劃中",type:"實體工作坊",size:"小型",targetAttendance:30,currentMilestone:"完成課綱與講師邀約",location:"線上＋台北教室",teams:["課務","宣傳"],budget:30000,description:"GPS 個人定位工作坊，包含課務、招生與活動前置。"}
  ],
  tasks: [
    {id:"sample-p1",name:"確認活動目標與預算上限",activityId:"sample-activity",phaseId:"P1",assignee:"活動夥伴 A",proxy:"嘉駿",jobRole:"活動總召",nextOwner:"活動夥伴 B",collaborators:["嘉駿"],startDate:"2026-08-29",due:"2026-09-05",priority:"高",status:"完成",progressPercent:100,effortHours:6,acceptanceCriteria:"理監事確認目標、80 人規模與 6 萬元預算上限。",executionSteps:["整理活動目標","確認預算邊界"],dependencies:[],blocker:"",flow:["建立任務","活動夥伴 A","活動夥伴 B","完成"],step:3},
    {id:"sample-p2",name:"整理活動骨架與宣傳資訊",activityId:"sample-activity",phaseId:"P2",assignee:"活動夥伴 B",proxy:"活動夥伴 A",jobRole:"公關企劃",nextOwner:"活動夥伴 A",collaborators:["嘉駿"],startDate:"2026-08-30",due:"2026-09-06",priority:"高",status:"完成",progressPercent:100,effortHours:10,acceptanceCriteria:"活動頁具備時間、地點、費用、報名方式與聯絡窗口。",dependencies:["sample-p1"],blocker:"",flow:["建立任務","活動夥伴 B","活動夥伴 A","完成"],step:3},
    {id:"sample-p3",name:"啟動首波宣傳與報名",activityId:"sample-activity",phaseId:"P3",assignee:"活動夥伴 B",proxy:"活動夥伴 A",jobRole:"公關行銷",nextOwner:"嘉駿",collaborators:["活動夥伴 A"],startDate:"2026-09-07",due:"2026-09-19",priority:"緊急",status:"等待回覆",progressPercent:70,effortHours:14,acceptanceCriteria:"完成三個渠道首波發布並取得至少 25 筆有效報名。",dependencies:["sample-p2"],blocker:"等待兩個合作社群回覆轉貼檔期。",flow:["建立任務","活動夥伴 B","嘉駿","完成"],step:1},
    {id:"sample-p4",name:"講師與主持流程定稿",activityId:"sample-activity",phaseId:"P4",assignee:"嘉駿",proxy:"活動夥伴 A",jobRole:"流程統籌",nextOwner:"活動夥伴 A",collaborators:["主持人","講師"],startDate:"2026-09-12",due:"2026-10-03",priority:"高",status:"進行中",progressPercent:45,effortHours:18,acceptanceCriteria:"講師、主持人與總召確認分鐘級流程和備案。",dependencies:["sample-p1"],blocker:"",flow:["建立任務","嘉駿","活動夥伴 A","完成"],step:1},
    {id:"sample-p5",name:"確認場地與餐飲合約",activityId:"sample-activity",phaseId:"P5",assignee:"活動夥伴 A",proxy:"嘉駿",jobRole:"場務主責",nextOwner:"嘉駿",collaborators:["場地方窗口"],startDate:"2026-09-13",due:"2026-10-10",priority:"緊急",status:"等待回覆",progressPercent:35,effortHours:12,acceptanceCriteria:"完成 80 人場地、餐飲與設備的書面確認。",dependencies:["sample-p1"],blocker:"等待場地方確認可容納人數與包廂。",flow:["建立任務","活動夥伴 A","嘉駿","完成"],step:1},
    {id:"sample-p6",name:"第二波宣傳與名單追蹤",activityId:"sample-activity",phaseId:"P6",assignee:"活動夥伴 B",proxy:"嘉駿",jobRole:"招募主責",nextOwner:"活動夥伴 A",collaborators:["公關行銷組"],startDate:"2026-09-19",due:"2026-10-17",priority:"一般",status:"待處理",progressPercent:10,effortHours:20,acceptanceCriteria:"報名達 70 人且完成待繳費與候補名單標記。",dependencies:["sample-p3"],blocker:"",flow:["建立任務","活動夥伴 B","活動夥伴 A","完成"],step:1},
    {id:"sample-p7",name:"物資盤點與全流程彩排",activityId:"sample-activity",phaseId:"P7",assignee:"嘉駿",proxy:"活動夥伴 A",jobRole:"現場統籌",nextOwner:"活動夥伴 A",collaborators:["主持組","場務組"],startDate:"2026-10-10",due:"2026-10-23",priority:"高",status:"待處理",progressPercent:0,effortHours:16,acceptanceCriteria:"物資表全數勾稽，彩排完成且風險均有負責人。",dependencies:["sample-p4","sample-p5"],blocker:"",flow:["建立任務","嘉駿","活動夥伴 A","完成"],step:0},
    {id:"sample-p8",name:"聯誼活動現場執行",activityId:"sample-activity",phaseId:"P8",assignee:"活動夥伴 A",proxy:"嘉駿",jobRole:"活動總召",nextOwner:"嘉駿",collaborators:["全體工作人員"],startDate:"2026-10-24",due:"2026-10-24",priority:"緊急",status:"待處理",progressPercent:0,effortHours:12,acceptanceCriteria:"活動依流程完成，重大異常完成紀錄與交接。",dependencies:["sample-p7"],blocker:"",flow:["建立任務","活動夥伴 A","嘉駿","完成"],step:0},
    {id:"sample-p9",name:"結算與成果報告",activityId:"sample-activity",phaseId:"P9",assignee:"嘉駿",proxy:"活動夥伴 A",jobRole:"結案主責",nextOwner:"活動夥伴 A",collaborators:["財務","公關"],startDate:"2026-10-31",due:"2026-11-07",priority:"一般",status:"待處理",progressPercent:0,effortHours:10,acceptanceCriteria:"完成收支結算、回饋摘要、照片歸檔與檢討紀錄。",dependencies:["sample-p8"],blocker:"",flow:["建立任務","嘉駿","活動夥伴 A","完成"],step:0},
    {id:"workshop-p1",name:"確認工作坊學習成果",activityId:"sample-workshop",phaseId:"P1",assignee:"嘉駿",proxy:"活動夥伴 A",jobRole:"課程主責",nextOwner:"活動夥伴 B",collaborators:["講師"],startDate:"2026-09-13",due:"2026-09-20",priority:"高",status:"完成",progressPercent:100,effortHours:5,acceptanceCriteria:"完成三項可驗收學習成果。",dependencies:[],blocker:"",flow:["建立任務","嘉駿","活動夥伴 B","完成"],step:3},
    {id:"workshop-p4",name:"課綱與教材初稿",activityId:"sample-workshop",phaseId:"P4",assignee:"嘉駿",proxy:"活動夥伴 A",jobRole:"課務",nextOwner:"講師",collaborators:["講師"],startDate:"2026-09-27",due:"2026-10-18",priority:"高",status:"進行中",progressPercent:25,effortHours:24,acceptanceCriteria:"課綱、講義與演練題可供內部試講。",dependencies:["workshop-p1"],blocker:"",flow:["建立任務","嘉駿","講師","完成"],step:1}
  ],
  meetings:[{id:"sample-meeting",title:"10/24 工作人員會議",activityId:"sample-activity",time:"2026-09-23T20:00:00+08:00",endTime:"2026-09-23T21:30:00+08:00",status:"待確認",type:"工作會議",organizer:"活動夥伴 A",recorder:"活動夥伴 B",location:"線上會議室",attendees:["嘉駿","活動夥伴 A","活動夥伴 B","活動夥伴 C"],attendeeResponses:[{name:"嘉駿",response:"出席"},{name:"活動夥伴 A",response:"出席"},{name:"活動夥伴 B",response:"待回覆"},{name:"活動夥伴 C",response:"待回覆"}],attending:2,total:4,agenda:"確認活動流程、工作人員分工、場地動線與尚未解決的卡點。"}],
  notices:[]
};

createRoot(document.getElementById("root")!).render(
  <Workspace preview user={{id:"preview",name:"嘉駿",email:""}} initialState={sample} />
);
