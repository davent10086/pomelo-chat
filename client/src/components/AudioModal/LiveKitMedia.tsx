import { useEffect, useRef } from 'react';
import type { LocalTrack, RemoteTrack } from 'livekit-client';

export const LiveKitMedia = ({ track, video = false, className }: { track?: LocalTrack | RemoteTrack; video?: boolean; className?: string }) => {
	const element = useRef<HTMLVideoElement>(null);
	useEffect(() => {
		const target = element.current;
		if (!target || !track) return;
		track.attach(target);
		return () => { track.detach(target); };
	}, [track]);
	return <video ref={element} className={className} autoPlay playsInline muted={false} style={video ? undefined : { opacity: 0, width: 0, height: 0 }} />;
};
