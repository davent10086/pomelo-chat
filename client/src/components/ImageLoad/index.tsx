import { LoadErrorImage } from '@/assets/images';
import { useAuthorizedMediaURL } from '@/utils/media-url';

interface ImageProps {
	src: string;
	alt?: string;
	className?: string;
}
const ImageLoad = (props: ImageProps) => {
	const { src, alt, className } = props;
	const url = useAuthorizedMediaURL(src || '');

	// 传入的加载图片src，可能是'https://ui-avatars.com/api/?name=xcgogogo'这种，也可能是'/uploads/group/8ewU4rs77Ky2uRmwzpgien3sI0l0XuIY.jpeg'这种
	return (
		<img
			src={
				src ? url || LoadErrorImage.AVATAR : LoadErrorImage.AVATAR
			}
			onError={e => {
				const fallback = new URL(LoadErrorImage.AVATAR, window.location.href).href;
				if (e.currentTarget.src !== fallback) {
					e.currentTarget.src = fallback;
				}
			}}
			alt={alt ? alt : ''}
			className={className}
			draggable="false"
		/>
	);
};

export default ImageLoad;
