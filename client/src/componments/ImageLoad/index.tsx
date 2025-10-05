import React from "react";
import { LoadErrorImage } from "@/assets/images";
import { serverURL } from "@/config";

interface ImageProps {
    src: string;
    alt?: string;
    className?: string;
}

/**
 * 图片加载组件
 * 处理图片路径拼接和加载失败时的默认图片显示
 * @param props - 图片属性接口 ImageProps
 * @param props.src - 图片源地址
 * @param props.alt - 图片描述文字
 * @param props.className - 图片样式类名
 */
const ImageLoad = (props:ImageProps)=>{
    const { src, alt, className } = props;

    return (
        <img 
            src={
                // 处理图片路径：如果是完整URL则直接使用，否则拼接服务器地址；如果src为空则使用默认头像
                src
                    ? src.startsWith('http') || src.startsWith('https')
                        ? `${src}`
                        : `${serverURL}/${src}`
                    : `${LoadErrorImage.AVATAR}`
            } 
            onError={e => {
                // 图片加载失败时的处理：如果当前图片不是默认头像，则替换为默认头像
                if (e.currentTarget.src !== `${LoadErrorImage.AVATAR}`){
                    (e.currentTarget.src = `${LoadErrorImage.AVATAR}`);
                    }
            }}
            alt={alt ? alt : ''}
            className={className}
            draggable={false}
        />
    );
};

export default ImageLoad;
