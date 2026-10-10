import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// 不使用 React.StrictMode：StrictMode 的「挂载→卸载→再挂载」与 Tauri 异步 listen
// （返回 Promise<UnlistenFn>）存在竞态，可能让事件监听被意外注销。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
