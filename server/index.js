const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// หน้าแรกสำหรับเช็กว่าเซิร์ฟเวอร์ตัวกลางทำงานปกติหรือไม่
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Hydroponic Middleware Server is running!'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
