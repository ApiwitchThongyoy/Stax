import React from 'react';

// 1. กำหนดประเภทข้อมูลให้กับ Props (Type Interface)
interface StaxLogoProps {
  width?: string;
  height?: string;
  className?: string;
  transparent?: boolean;
  textColor?: string;      // สีของคำว่า "STAX" และ "S" / "x"
  subTextColor?: string;   // สีของ "Smart Tax & Accounting" และสโลแกนไทย
  dividerColor?: string;   // สีเส้นคั่น
}

// 2. ระบุประเภทข้อมูล : React.FC<StaxLogoProps> ให้กับตัว Component
const StaxLogo: React.FC<StaxLogoProps> = ({ 
  width = "100%", 
  height = "auto", 
  className = "", 
  transparent = false,
  textColor,        
  subTextColor,      
  dividerColor       
}) => {
  const brandColor = textColor || '#0052cc';
  const subColor = subTextColor || '#4a7bb0';
  const lineColor = dividerColor || '#bcccda';

  return (
    <div 
      className={`stax-logo-container ${className}`} 
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: transparent ? '0' : '20px',
        backgroundColor: transparent ? 'transparent' : '#ffffff',
        borderRadius: transparent ? '0' : '24px',
        boxShadow: transparent ? 'none' : '0 4px 20px rgba(0, 0, 0, 0.05)',
        fontFamily: "'Helvetica Neue', Helvetica, Arial, 'Noto Sans Thai', sans-serif",
        maxWidth: '400px',
        margin: '0 auto',
        width: width,
        height: height
      }}
    >
      {/* Graphic Logo Section */}
      <div style={{ position: 'relative', width: '240px', height: '180px', marginBottom: '10px' }}>
        <svg viewBox="0 0 240 180" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg">
          {/* Central Isometric Hexagon Cube Structure */}
          <g transform="translate(120, 85)">
            {/* Hexagon Outline / Back Walls */}
            <polygon points="0,-50 43,-25 43,25 0,50 -43,25 -43,-25" fill="none" stroke="#26c2a3" strokeWidth="5" strokeLinejoin="round" />
            
            {/* Inner Cube Lines */}
            <line x1="0" y1="0" x2="0" y2="50" stroke="#26c2a3" strokeWidth="3" />
            <line x1="0" y1="0" x2="43" y2="-25" stroke="#1c355e" strokeWidth="3" />
            <line x1="0" y1="0" x2="-43" y2="-25" stroke="#1c355e" strokeWidth="3" />

            {/* Bar Chart Graphics inside the right/bottom sections */}
            <rect x="-25" y="5" width="6" height="15" fill="#26c2a3" opacity={0.8} />
            <rect x="-15" y="-5" width="6" height="25" fill="#26c2a3" opacity={0.8} />
            <rect x="-5" y="-15" width="6" height="35" fill="#26c2a3" />
            <rect x="5" y="-20" width="6" height="40" fill="#26c2a3" />
            <rect x="15" y="-30" width="6" height="50" fill="#26c2a3" />

            {/* Rising Arrow Trend Line */}
            <path d="M -30,20 L -10,0 L 10,-15 L 25,-40" fill="none" stroke="#1c355e" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            <polygon points="25,-45 28,-35 18,-38" fill="#1c355e" />
          </g>

          {/* Large Stylized 'S' on the Left */}
          <text 
            x="35" 
            y="100" 
            fill={brandColor} 
            style={{ 
              fontSize: '110px', 
              fontWeight: 'bold', 
              fontFamily: 'Arial, sans-serif',
              letterSpacing: '-5px'
            }}
          >
            S
          </text>

          {/* Smaller Stylized 'x' on the Right */}
          <text 
            x="175" 
            y="100" 
            fill={brandColor} 
            style={{ 
              fontSize: '65px', 
              fontWeight: 'bold', 
              fontFamily: 'Arial, sans-serif' 
            }}
          >
            x
          </text>
        </svg>
      </div>

      {/* Brand Text Section */}
      <div style={{ textTransform: 'uppercase', color: brandColor, fontSize: '24px', fontWeight: '800', letterSpacing: '1px', marginBottom: '2px' }}>
        STAX
      </div>
      
      <div style={{ color: subColor, fontSize: '13px', fontWeight: '600', letterSpacing: '0.5px', marginBottom: '12px' }}>
        Smart Tax & Accounting
      </div>

      {/* Divider Line */}
      <div style={{ width: '80%', height: '2px', backgroundColor: lineColor, marginBottom: '12px' }}></div>

      {/* Thai Slogan Section */}
      <div style={{ color: subColor, fontSize: '13px', fontWeight: 'bold', letterSpacing: '0.2px' }}>
        ระบบบัญชีและประเมินภาษีอัจฉริยะ
      </div>
    </div>
  );
};

export default StaxLogo;