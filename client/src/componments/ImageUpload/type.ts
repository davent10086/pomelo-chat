/**
 * 图片上传组件的属性接口
 * 定义了图片上传组件所需的配置参数和回调函数
 */
export interface IImageUploadProps {
    /**
     * 上传成功后的回调函数
     * @param filePath 上传成功后返回的文件路径
     */
    onUploadSuccess:(filePath:string) => void;
    
    /**
     * 初始图片路径（可选）
     * 用于显示默认图片或已上传的图片
     */
    initialImageUrl?: string | null;
}