import { App, } from "antd";

/**
 * 自定义Hook，用于显示消息提示
 * @returns 返回一个函数，用于显示指定类型的消息
 * @returns type 消息类型，可选值为'success' | 'error' | 'warning' | 'info'
 * @returns text 消息文本内容
 * @returns duration 消息显示持续时间（秒），默认为3秒
 */
const useShowMessage =()=>{
    const { message } = App.useApp();
    return (type:'success' | 'error' | 'warning' | 'info',text:string,duration?:number) =>{
        message[type](text,duration || 3);
    };
};

export default useShowMessage;