import  Request  from "./request";

/**
 * 文件验证参数接口
 * 包含文件哈希值、总块数和文件扩展名
 */
interface IVertifyParams {
    fileHash: string;
    totalCount: number;
    extname: string;
}

/**
 * 文件验证响应接口
 * 包含需要上传的文件块列表、消息和文件路径
 */
interface IVertifyres{
    neededFileList:number[];
    message:string;
    filePath?:string;
}

/**
 * 上传文件块参数接口
 * 包含文件块数据、块索引、文件哈希值和文件扩展名
 */
interface IUploadChunkparams{
    chunk:ArrayBuffer;
    chunkIndex:number;
    fileHash:string;
    extname:string;
}

/**
 * 合并文件参数接口
 * 包含文件哈希值和文件扩展名
 */
interface IMergeFileParams{
    fileHash:string;
    extname:string
}

/**
 * 验证文件上传状态
 * @param params - 验证参数对象，包含文件哈希值、总块数和文件扩展名
 * @returns 返回验证结果，包括需要上传的文件块列表、消息和文件路径
 */
export const vertifyFile = async (params:IVertifyParams) =>{
    const res = await Request.post<IVertifyParams,IVertifyres>('/file/verify_file',params)
    return res.data;
}

/**
 * 上传文件块
 * @param params - 上传参数对象，包含文件块数据、块索引、文件哈希值和文件扩展名
 * @returns 返回上传结果
 */
export const uploadChunk = async (params:IUploadChunkparams) =>{
    // 创建表单数据用于文件块上传
    const formData = new FormData();
    formData.append('chunk',new Blob([params.chunk]));
    formData.append('chunkIndex',params.chunkIndex.toString());
    formData.append('fileHash',params.fileHash);
    formData.append('extname',params.extname);
    const res = await Request.post<FormData,any>('/file/upload_chunk',formData)
    return res.data;
};

/**
 * 合并文件块为完整文件
 * @param params - 合并参数对象，包含文件哈希值和文件扩展名
 * @returns 返回合并结果
 */
export const mergeFile = async (params:IMergeFileParams) =>{
    const res = await Request.post<IMergeFileParams,any>('/file/merge_file',params)
    return res.data;
}