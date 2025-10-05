import {LoadingOutlined,PlusOutlined} from '@ant-design/icons';
import { Upload } from 'antd';
import { useState,useEffect } from 'react';

import styles from './index.module.less';
import { IImageUploadProps } from './type';

import ImageLoad  from '@/componments/ImageLoad';
import useShowMessage from '../hooks/useShowMessage';
import { uploadFile } from '../../utils/file-upload';

/**
 * 图片上传组件
 * @param props - 包含上传成功回调和初始图片URL的属性对象
 * @returns 图片上传组件的JSX元素
 */
export const ImageUpLoad = (props:IImageUploadProps) => {
    const {onUploadSuccess,initialImageUrl} = props;
    const showMessage = useShowMessage();
    const [imageUrl, setImageUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleUpload = async (options: any ) => {
        setLoading(true);
        const file = options.file;
        // 检查文件大小是否超过10MB限制
        if (file.size > 10 * 1024 * 1024){
            showMessage('error','图片大小不能超过10M');
            setLoading(false);
            return;
        }
        try {
            // 调用上传文件函数，上传图片并获取结果
            const res = await uploadFile(file,5);
            if (res.success && res.filePath){
                setImageUrl(res.filePath);
                onUploadSuccess(res.filePath);
            } else {
                showMessage('error',res.message || '上传失败');
            }
        } catch  {
            showMessage('error','上传失败');
        }finally {
            setLoading(false);
        }
    };
    // 定义上传按钮的显示内容，根据加载状态显示不同图标
    const uploadButton = (
        <div>
            {loading ? <LoadingOutlined /> : <PlusOutlined />}
            <div style={{ marginTop: 8 }}>上传图片</div>
        </div>
        );

        // 初始化时设置初始图片URL
        useEffect(() => {
            if (initialImageUrl){
                setImageUrl(initialImageUrl);
                }
            },[]);

            return (
            <>
                <Upload
                    listType='picture-card'
                    showUploadList={false}
                    customRequest={handleUpload}
                    accept='image/*'
                    maxCount={1}
                    className={styles.avatarUploader}>
                        {imageUrl ? <ImageLoad src={imageUrl} alt='avatar' /> : uploadButton}
                    </Upload>
            </>
        );
};