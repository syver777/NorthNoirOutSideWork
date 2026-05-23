import React, { useEffect, useState } from 'react';

interface RatingWheelProps {
  rating: number;
  label: string;
}

const RatingWheel: React.FC<RatingWheelProps> = ({ rating, label }) => {
  const [animatedRating, setAnimatedRating] = useState(0);
  const radius = 60;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (animatedRating / 10) * circumference;

  useEffect(() => {
    const timer = setTimeout(() => {
      setAnimatedRating(rating);
    }, 500);

    return () => clearTimeout(timer);
  }, [rating]);

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg className="transform -rotate-90 w-40 h-40">
        <circle
          className="text-gray-700"
          strokeWidth="8"
          stroke="currentColor"
          fill="transparent"
          r={radius}
          cx="80"
          cy="80"
        />
        <circle
          className="text-red-500 transition-all duration-1000 ease-out"
          strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          stroke="currentColor"
          fill="transparent"
          r={radius}
          cx="80"
          cy="80"
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="text-4xl font-bold text-white">
          {animatedRating.toFixed(1)}
        </span>
        <span className="text-sm text-gray-400">out of 10</span>
      </div>
    </div>
  );
};

export default RatingWheel;
