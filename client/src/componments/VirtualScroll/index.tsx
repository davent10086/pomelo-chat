import React, { useState, useRef, useCallback } from 'react';
import classNames from 'classnames';
import styles from './index.module.less';

/**
 * 虚拟滚动组件属性接口
 * @template T 项目数据类型
 */
interface VirtualScrollProps<T> {
  /**
   * 需要渲染的项目列表
   */
  items: T[];
  /**
   * 每个项目的高度（像素）
   */
  itemHeight: number;
  /**
   * 容器的高度（像素）
   */
  containerHeight: number;
  /**
   * 渲染单个项目的函数
   * @param item 当前项目数据
   * @param index 当前项目索引
   * @returns 渲染的React节点
   */
  renderItem: (item: T, index: number) => React.ReactNode;
  /**
   * 自定义CSS类名
   */
  className?: string;
}

/**
 * 虚拟滚动组件，用于高效渲染大量数据列表
 * 通过只渲染可见区域内的项目来提升性能
 * @template T 项目数据类型
 * 
 * @param items 需要渲染的项目列表
 * @param itemHeight 每个项目的高度（像素）
 * @param containerHeight 容器的高度（像素）
 * @param renderItem 渲染单个项目的函数
 * @param className 自定义CSS类名
 * 
 * @returns 虚拟滚动容器组件
 */
const VirtualScroll = <T,>({
  items,
  itemHeight,
  containerHeight,
  renderItem,
  className,
}: VirtualScrollProps<T>) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  
  // 计算可见区域内的项目数量
  const visibleCount = Math.ceil(containerHeight / itemHeight);
  
  // 计算开始和结束索引
  const startIndex = Math.floor(scrollTop / itemHeight);
  const endIndex = Math.min(startIndex + visibleCount + 2, items.length); // 多渲染几个项目以避免空白
  
  // 计算偏移量
  const offsetY = startIndex * itemHeight;
  
  // 获取可见项目
  const visibleItems = items.slice(startIndex, endIndex);
  
  // 处理滚动事件
  const handleScroll = useCallback(() => {
    if (containerRef.current) {
      setScrollTop(containerRef.current.scrollTop);
    }
  }, []);
  
  // 总高度
  const totalHeight = items.length * itemHeight;
  
  return (
    <div 
      ref={containerRef}
      className={classNames(styles.virtualScrollContainer, className)}
      style={{ height: containerHeight, overflow: 'auto' }}
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ 
          transform: `translateY(${offsetY}px)`,
          position: 'absolute',
          left: 0,
          right: 0
        }}>
          {visibleItems.map((item, index) => (
            <div 
              key={startIndex + index} 
              style={{ height: itemHeight }}
            >
              {renderItem(item, startIndex + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default VirtualScroll;