const jwt = require('jsonwebtoken');
require('dotenv').config();

const verifyUser = (req, res, next) => {
    // Get token from header
    const token = req.header('Authorization')?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ 
            success: false, 
            message: 'Access denied. No token provided.' 
        });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key');
        
        // Add wallet address to request object
        req.walletAddress = decoded.walletAddress;
        next();
    } catch (error) {
        console.error('JWT Verification Error:', error);
        return res.status(401).json({ 
            success: false, 
            message: 'Invalid or expired token' 
        });
    }
};

module.exports = verifyUser;