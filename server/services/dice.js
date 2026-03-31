export function roll(sides=20){ return Math.floor(Math.random()*sides)+1; }
export function d20(){ return roll(20); }
export function mod(stat=10){ return Math.floor((stat-10)/2); }
